use super::*;

pub(super) struct OutputFormatResolutionMessages<'a> {
    pub(super) flag_label: &'a str,
    pub(super) format_noun: &'a str,
    pub(super) missing_extension_label: &'a str,
    pub(super) raw_output_hint: &'a str,
    pub(super) supported_formats: Option<&'a str>,
}

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
        // The process token, so a Ctrl-C reaches work already running. On wasm
        // and in tests nothing ever trips it, so it behaves like a fresh one.
        OperationContext::new(
            thread_budget,
            temp_root,
            reporter,
            process_cancellation_token(),
        )
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
        compress_level: Option<CompressionLevelProfile>,
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
                level_explicit: false,
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
            level_explicit: compress_level.is_some(),
            profile: compress_level.unwrap_or_default(),
        })
    }

    /// Resolve the default patch-apply output mode after the selected ROM leaf
    /// is known. An explicit compression flag keeps its historical precedence;
    /// otherwise a registered container extension means compression and the
    /// leaf's own extension means raw output.
    pub(super) fn resolve_patch_apply_compression_options(
        &self,
        no_compress: bool,
        compress_format: Option<String>,
        compress_codec: Vec<String>,
        compress_level: Option<CompressionLevelProfile>,
        output: &Path,
        extension_source: &Path,
    ) -> Result<PatchApplyCompressionOptions> {
        let mut options = Self::parse_patch_apply_compression_options(
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
        )?;
        if no_compress {
            return Ok(options);
        }
        if options.requested_format.is_some()
            || options.codec.is_some()
            || options.level.is_some()
            || options.level_explicit
        {
            self.resolve_patch_apply_compression_plan(output, extension_source, &options)?;
            return Ok(options);
        }

        let Some(output_extension) = output.extension().and_then(|value| value.to_str()) else {
            return Err(RomWeaverError::Validation(
                "output has no file extension; pass --no-compress for a raw ROM or use --compress-format <name>"
                    .to_string(),
            ));
        };
        if self.containers.find_by_output_extension(output).is_some() {
            self.resolve_patch_apply_compression_plan(output, extension_source, &options)?;
            return Ok(options);
        }

        let source_extension = extension_source
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty());
        if source_extension
            .is_some_and(|source_extension| source_extension.eq_ignore_ascii_case(output_extension))
        {
            if is_ambiguous_disc_image_extension(output_extension) {
                return Err(RomWeaverError::Validation(format!(
                    "output extension `.{output_extension}` is ambiguous between a raw ROM and a disc image; pass --no-compress or --compress-format <name>"
                )));
            }
            options.enabled = false;
            return Ok(options);
        }

        let source_hint = source_extension
            .map(|extension| format!(" (selected ROM leaf extension is `.{extension}`)"))
            .unwrap_or_else(|| " (the selected ROM leaf has no file extension)".to_string());
        Err(RomWeaverError::Validation(format!(
            "output extension `.{output_extension}` is neither a registered container nor the selected ROM leaf extension{source_hint}; pass --no-compress, --compress-format <name>, or use the ROM extension"
        )))
    }

    /// Resolve an output format from an explicit flag and/or the output extension. The caller
    /// supplies registry-specific normalization and descriptor lookups; capability checks stay
    /// outside this shared precedence and warning logic.
    pub(super) fn resolve_output_format_core(
        flag: Option<&str>,
        output: &Path,
        normalize_flag: fn(&str) -> String,
        flag_canonical_name: Option<&str>,
        extension_name: Option<&str>,
        messages: OutputFormatResolutionMessages<'_>,
    ) -> Result<FormatResolution> {
        let OutputFormatResolutionMessages {
            flag_label,
            format_noun,
            missing_extension_label,
            raw_output_hint,
            supported_formats,
        } = messages;
        let extension_display = output
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"));

        if let Some(flag) = flag {
            let normalized = normalize_flag(flag);
            let warning = match &extension_display {
                None => None,
                Some(extension) => {
                    let matches = match (flag_canonical_name, extension_name) {
                        (Some(flag_name), Some(extension_name)) => {
                            flag_name.eq_ignore_ascii_case(extension_name)
                        }
                        _ => false,
                    };
                    if matches {
                        None
                    } else {
                        Some(format!(
                            "output extension `{extension}` does not match {flag_label} `{flag}`; writing `{normalized}`"
                        ))
                    }
                }
            };
            return Ok(FormatResolution {
                format: normalized.clone(),
                note: format!("explicit format={normalized}"),
                warning,
            });
        }

        let Some(extension_display) = extension_display else {
            return Err(RomWeaverError::Validation(format!(
                "output has no file extension; pass {flag_label} <name> or use {missing_extension_label}{raw_output_hint}"
            )));
        };
        match extension_name {
            Some(resolved) => Ok(FormatResolution {
                note: format!("format={resolved} from output extension"),
                format: resolved.to_string(),
                warning: None,
            }),
            None => Err(RomWeaverError::Validation(format!(
                "output extension `{extension_display}` is not a supported {format_noun}; pass {flag_label} <name> or use a supported extension{raw_output_hint}{}",
                supported_formats
                    .map(|formats| format!(". Supported output formats: {formats}"))
                    .unwrap_or_default()
            ))),
        }
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
        let flag_canonical_name = flag.and_then(|flag| {
            self.containers
                .find_by_name(flag)
                .map(|handler| handler.descriptor().name.to_string())
        });
        let extension_name = self
            .containers
            .find_by_output_extension(output)
            .map(|handler| handler.descriptor().name);
        let supported_formats = rom_weaver_containers::supported_create_formats_text();

        Self::resolve_output_format_core(
            flag,
            output,
            str::to_string,
            flag_canonical_name.as_deref(),
            extension_name,
            OutputFormatResolutionMessages {
                flag_label,
                format_noun: "format",
                missing_extension_label: "a supported extension",
                raw_output_hint,
                supported_formats: Some(&supported_formats),
            },
        )
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
        if options.level_explicit && level.is_none() {
            return Err(RomWeaverError::Validation(format!(
                "{resolved_format} does not accept --compress-level"
            )));
        }
        Self::validate_patch_apply_compression_codec(&resolved_format, codec.as_deref(), level)?;

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

    fn validate_patch_apply_compression_codec(
        format: &str,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<()> {
        let Some(codec) = codec else {
            return Ok(());
        };
        let metadata = compression_metadata();
        let supported = match format.to_ascii_lowercase().as_str() {
            "zip" | "zipx" => ["deflate", "store", "zstd"].as_slice(),
            "7z" => ["lzma2"].as_slice(),
            "rvz" | "z3ds" => ["zstd"].as_slice(),
            "chd" => [
                "store", "zstd", "lzma", "zlib", "huff", "flac", "cdzs", "cdlz", "cdzl", "cdfl",
                "avhuff",
            ]
            .as_slice(),
            _ => {
                return Err(RomWeaverError::Validation(format!(
                    "{format} does not accept --compress-codec"
                )));
            }
        };
        let requested_codecs = codec.split('+').map(str::trim).collect::<Vec<_>>();
        if !format.eq_ignore_ascii_case("chd") && requested_codecs.len() > 1 {
            return Err(RomWeaverError::Validation(format!(
                "{format} accepts one --compress-codec value"
            )));
        }
        let mut primary_metadata = None;
        let mut canonical_codecs = Vec::with_capacity(requested_codecs.len());
        for requested in requested_codecs {
            let Some(codec_metadata) = metadata.codecs.iter().find(|entry| {
                entry.name.eq_ignore_ascii_case(requested)
                    || entry
                        .aliases
                        .iter()
                        .any(|alias| alias.eq_ignore_ascii_case(requested))
            }) else {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {format} codec `{requested}`"
                )));
            };
            if !supported
                .iter()
                .any(|name| name.eq_ignore_ascii_case(codec_metadata.name))
            {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {format} codec `{requested}`"
                )));
            }
            primary_metadata.get_or_insert(codec_metadata);
            canonical_codecs.push(codec_metadata.name);
        }
        if format.eq_ignore_ascii_case("chd") {
            if canonical_codecs.len() > 4 {
                return Err(RomWeaverError::Validation(format!(
                    "chd supports at most 4 codecs; received {}",
                    canonical_codecs.len()
                )));
            }
            if canonical_codecs
                .first()
                .is_some_and(|codec| *codec == "store")
                && canonical_codecs.len() > 1
            {
                return Err(RomWeaverError::Validation(
                    "chd codec `store` cannot be combined with additional codecs".to_string(),
                ));
            }
            if canonical_codecs
                .iter()
                .skip(1)
                .any(|codec| *codec == "avhuff")
            {
                return Err(RomWeaverError::Validation(
                    "chd codec `avhuff` must be the first codec when multiple codecs are provided"
                        .to_string(),
                ));
            }
        }
        if let (Some(level), Some(codec_metadata)) = (level, primary_metadata) {
            let Some(range) = codec_metadata.level else {
                return Err(RomWeaverError::Validation(format!(
                    "{format} codec `{}` does not accept --level",
                    codec_metadata.name
                )));
            };
            if !(range.min..=range.max).contains(&level) {
                return Err(RomWeaverError::Validation(format!(
                    "compression level {level} is invalid for {format} codec `{}` (expected {}..={})",
                    codec_metadata.name, range.min, range.max
                )));
            }
        }
        Ok(())
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
