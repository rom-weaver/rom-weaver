impl CliApp {
    fn emit_running(
        &self,
        command: &str,
        family: OperationFamily,
        format: Option<&str>,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
    ) {
        if !self.emit_progress_events {
            return;
        }

        let stage = stage.into();
        let label = label.into();
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
        let thread_execution = thread_execution.as_ref();
        self.reporter.emit(ProgressEvent {
            command: command.to_string(),
            family,
            format: format.map(str::to_string),
            stage,
            label,
            details: None,
            percent,
            requested_threads: thread_execution.map(|value| value.requested_threads),
            effective_threads: thread_execution.map(|value| value.effective_threads),
            thread_mode: thread_execution.map(|value| value.thread_mode),
            used_parallelism: thread_execution.map(|value| value.used_parallelism),
            thread_fallback: thread_execution.map(|value| value.thread_fallback),
            thread_fallback_reason: thread_execution
                .and_then(|value| value.thread_fallback_reason.clone()),
            status: OperationStatus::Running,
        });
    }

    fn context(&self, thread_budget: ThreadBudget) -> OperationContext {
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

    fn default_temp_root() -> PathBuf {
        if let Some(pwd) = std::env::var_os("PWD").map(PathBuf::from)
            && pwd.is_absolute()
        {
            return pwd.join("rom-weaver");
        }

        PathBuf::from("rom-weaver")
    }

    fn runtime_process_id() -> u32 {
        #[cfg(target_family = "wasm")]
        {
            return 1;
        }

        #[cfg(not(target_family = "wasm"))]
        {
            std::process::id()
        }
    }

    fn resolve_codec_level(
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

    fn parse_codec_entries(codecs: Vec<String>, flag_name: &str) -> Result<Vec<String>> {
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

    fn primary_codec_name(codec: Option<&str>) -> Option<&str> {
        codec.and_then(|value| {
            value
                .split([',', '+'])
                .map(str::trim)
                .find(|entry| !entry.is_empty())
        })
    }

    fn resolve_compression_level_for_profile(
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

    fn default_profile_codec_kind_for_format(format_name: &str) -> Option<ProfileCodecKind> {
        let normalized = format_name.trim().to_ascii_lowercase();
        if normalized == "chd" || normalized.starts_with("chd-") {
            return Some(ProfileCodecKind::Standard);
        }
        match normalized.as_str() {
            "zip" | "7z" | "tar.gz" | "tar.bz2" | "tar.xz" | "gz" | "bz2" | "xz" | "wia" => {
                Some(ProfileCodecKind::Standard)
            }
            "zipx" | "zst" | "zstd" | "rvz" | "z3ds" | "3ds" => Some(ProfileCodecKind::Zstd),
            "tar" => Some(ProfileCodecKind::NoLevel),
            _ => None,
        }
    }

    fn profile_codec_kind_for_codec_name(codec_name: &str) -> Option<ProfileCodecKind> {
        let codec = codec_name.trim();
        if codec.is_empty() {
            return None;
        }
        if codec.eq_ignore_ascii_case("cdzs")
            || codec.eq_ignore_ascii_case("zstd")
            || codec.eq_ignore_ascii_case("zst")
            || codec.eq_ignore_ascii_case("zstandard")
        {
            return Some(ProfileCodecKind::Zstd);
        }
        if codec.eq_ignore_ascii_case("cdzl") || codec.eq_ignore_ascii_case("cdlz") {
            return Some(ProfileCodecKind::Standard);
        }
        if codec.eq_ignore_ascii_case("flac") || codec.eq_ignore_ascii_case("cdfl") {
            return Some(ProfileCodecKind::Standard);
        }
        if codec.eq_ignore_ascii_case("store")
            || codec.eq_ignore_ascii_case("none")
            || codec.eq_ignore_ascii_case("uncompressed")
            || codec.eq_ignore_ascii_case("huffman")
            || codec.eq_ignore_ascii_case("huff")
            || codec.eq_ignore_ascii_case("avhuff")
            || codec.eq_ignore_ascii_case("avhu")
        {
            return Some(ProfileCodecKind::NoLevel);
        }
        match parse_requested_codec(Some(codec)) {
            RequestedCodec::Known(CanonicalCodec::Store) => Some(ProfileCodecKind::NoLevel),
            RequestedCodec::Known(CanonicalCodec::Zstd) => Some(ProfileCodecKind::Zstd),
            RequestedCodec::Known(CanonicalCodec::Huffman) => Some(ProfileCodecKind::NoLevel),
            RequestedCodec::Known(_) => Some(ProfileCodecKind::Standard),
            RequestedCodec::Unspecified | RequestedCodec::Unknown(_) => None,
        }
    }

    fn parse_patch_apply_compression_options(
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
                auto_mode: false,
                requested_format: None,
                codec: None,
                level: None,
                profile: CompressionLevelProfile::High,
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
                if trimmed.eq_ignore_ascii_case("auto") {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            None => None,
        };
        let auto_mode = requested_format.is_none();
        let (codec, level) = Self::resolve_codec_level(compress_codec, "--compress-codec")?;
        Ok(PatchApplyCompressionOptions {
            enabled: true,
            auto_mode,
            requested_format,
            codec,
            level,
            profile: compress_level,
        })
    }

    fn detect_patch_apply_outer_container_format(
        &self,
        source: &Path,
        context: &OperationContext,
    ) -> Option<String> {
        let handler = self.containers.probe(source)?;
        if !handler.capabilities().create {
            return None;
        }
        if matches!(handler.probe(source), ProbeConfidence::Extension)
            && handler
                .inspect(
                    &ContainerInspectRequest {
                        source: source.to_path_buf(),
                    },
                    context,
                )
                .is_err()
        {
            return None;
        }
        Some(handler.descriptor().name.to_string())
    }

    fn resolve_patch_apply_compression_plan(
        &self,
        requested_output: &Path,
        raw_output: &Path,
        extension_source: &Path,
        outer_container_format: Option<&str>,
        options: &PatchApplyCompressionOptions,
    ) -> Result<PatchApplyCompressionPlan> {
        if !options.enabled {
            return Err(RomWeaverError::Validation(
                "patch-output compression was not enabled".to_string(),
            ));
        }

        let (resolved_format, auto_note) = if options.auto_mode {
            if let Some(format_name) = outer_container_format
                && self.patch_apply_format_supports_create(format_name)
            {
                (
                    format_name.to_string(),
                    format!("auto format={format_name} reason=outer-input-container"),
                )
            } else {
                let recommendation = self.containers.recommend_compress_format(raw_output);
                if recommendation.format_name.eq_ignore_ascii_case("rvz")
                    && self.patch_apply_format_supports_create("rvz")
                {
                    (
                        "rvz".to_string(),
                        format!("auto format=rvz reason={}", recommendation.reason),
                    )
                } else if self.patch_apply_chd_auto_viable(raw_output) {
                    (
                        "chd".to_string(),
                        "auto format=chd reason=viable-non-disc-output".to_string(),
                    )
                } else if self.patch_apply_format_supports_create("7z") {
                    (
                        "7z".to_string(),
                        "auto format=7z reason=fallback-7z-lzma2".to_string(),
                    )
                } else if self.patch_apply_format_supports_create(recommendation.format_name) {
                    (
                        recommendation.format_name.to_string(),
                        format!(
                            "auto format={} reason={}",
                            recommendation.format_name, recommendation.reason
                        ),
                    )
                } else {
                    return Err(RomWeaverError::Validation(
                        "no registered container format can compress patch output".to_string(),
                    ));
                }
            }
        } else {
            let explicit_format = options.requested_format.clone().ok_or_else(|| {
                RomWeaverError::Validation(
                    "internal validation error: explicit patch-output compression mode requires --compress-format".to_string(),
                )
            })?;
            (
                explicit_format.clone(),
                format!("explicit format={explicit_format}"),
            )
        };

        let Some(handler) = self.containers.find_by_name(&resolved_format) else {
            return Err(RomWeaverError::Validation(
                "requested output format is not registered".to_string(),
            ));
        };
        let capabilities = handler.capabilities();
        if !capabilities.inspect && !capabilities.extract && !capabilities.create {
            return Err(RomWeaverError::Validation(
                "requested output format is not registered".to_string(),
            ));
        }

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

        let (output_path, extension_appended) = Self::append_output_extension_if_missing(
            requested_output,
            handler.descriptor().extensions,
            Some(extension_source),
        );
        Ok(PatchApplyCompressionPlan {
            format: resolved_format,
            codec,
            level,
            output_path,
            extension_appended,
            auto_note,
        })
    }

    fn patch_apply_format_supports_create(&self, format_name: &str) -> bool {
        self.containers
            .find_by_name(format_name)
            .is_some_and(|handler| handler.capabilities().create)
    }

    fn patch_apply_chd_auto_viable(&self, source: &Path) -> bool {
        if !self.patch_apply_format_supports_create("chd") {
            return false;
        }
        let Ok(metadata) = fs::metadata(source) else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }
        let logical_bytes = metadata.len();
        // Prevent a known backend abort path for very small CHD inputs.
        if logical_bytes <= 4096 {
            return false;
        }

        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("iso") => logical_bytes % 2048 == 0,
            Some("img") | Some("ima") => logical_bytes % 512 == 0,
            _ => true,
        }
    }

    fn append_output_extension_if_missing(
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

    fn z3ds_compressed_extension_for_path(path: &Path) -> Option<&'static str> {
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

    fn normalize_trim_extension(extension: &str) -> Result<String> {
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

    const fn default_trim_extension_pattern(operation: TrimOperation) -> &'static str {
        match operation {
            TrimOperation::Trim => "trim.{ext}",
            TrimOperation::Revert => "untrim.{ext}",
        }
    }
}
