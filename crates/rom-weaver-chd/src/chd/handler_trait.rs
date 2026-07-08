use super::*;

impl ContainerHandlerOperations for ChdContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &CHD
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if file_starts_with(source, &CHD_SIGNATURE) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let chd = ChdReadSession::open(&request.source, None)?;
        let header = chd.header();
        let media_kind = chd.media_kind();
        let sha1 = self.header_sha1_hex(header);
        let raw_sha1 = self.header_raw_sha1_hex(header);
        let digest_suffix = match (&sha1, &raw_sha1) {
            (Some(sha1), Some(raw_sha1)) => format!(", sha1={sha1}, raw_sha1={raw_sha1}"),
            (Some(sha1), None) => format!(", sha1={sha1}"),
            (None, Some(raw_sha1)) => format!(", raw_sha1={raw_sha1}"),
            (None, None) => String::new(),
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(CHD.name.to_string()),
            "probe",
            format!(
                "{} chd v{}: {} bytes, {}-byte hunks, codec={}{}",
                self.media_label(media_kind),
                header.version,
                header.logical_bytes,
                header.hunk_bytes,
                self.header_codec_label(header),
                digest_suffix
            ),
            Some(100.0),
            Some(execution),
        );
        let mut details = Map::new();
        let mut chd_details = Map::new();
        chd_details.insert(
            "media_kind".to_string(),
            json!(self.media_label(media_kind)),
        );
        if let Some(sha1) = sha1 {
            chd_details.insert("sha1".to_string(), json!(sha1));
        }
        if let Some(raw_sha1) = raw_sha1 {
            chd_details.insert("raw_sha1".to_string(), json!(raw_sha1));
        }
        details.insert("chd".to_string(), Value::Object(chd_details));
        report.details = Some(Value::Object(details));
        Ok(report)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let chd = ChdReadSession::open(&request.source, None)?;
        let media_kind = chd.media_kind();
        let stem = request
            .source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        if media_kind == ChdMediaKind::CdRom {
            let layout = self.read_disc_tracks(&chd, DiscKind::CdRom)?;
            let first_data_bytes = layout
                .tracks
                .first()
                .map(|track| track.mode.data_bytes())
                .unwrap_or(2352);
            let single_bin = layout
                .tracks
                .iter()
                .all(|track| track.mode.data_bytes() == first_data_bytes);
            let mut entries = vec![format!("{stem}.cue")];
            if single_bin {
                entries.push(format!("{stem}.bin"));
            } else {
                for track in &layout.tracks {
                    entries.push(self.track_output_name(stem, track.number));
                }
            }
            return Ok(entries);
        }
        if media_kind == ChdMediaKind::GdRom {
            let layout = self.read_disc_tracks(&chd, DiscKind::GdRom)?;
            let mut entries = vec![format!("{stem}.gdi")];
            for track in &layout.tracks {
                entries.push(self.track_output_name(stem, track.number));
            }
            return Ok(entries);
        }
        Ok(vec![self.extract_name(&request.source, media_kind)?])
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        // Enumerate the produced output files and their sizes from the CHD header/track metadata
        // only (no hunk decode), so input discovery can list a `.cue` + `.bin`(s) — or the single
        // raw image — without performing a full extract.
        let chd = ChdReadSession::open(&request.source, None)?;
        let media_kind = chd.media_kind();
        let stem = request
            .source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        let track_bin_bytes = |track: &DiscTrack| -> u64 {
            u64::from(track.frames).saturating_mul(track.mode.data_bytes() as u64)
        };
        if media_kind == ChdMediaKind::CdRom {
            let layout = self.read_disc_tracks(&chd, DiscKind::CdRom)?;
            let first_data_bytes = layout
                .tracks
                .first()
                .map(|track| track.mode.data_bytes())
                .unwrap_or(2352);
            // Mirror the extract naming decision: a single BIN is only produced when every track
            // shares a sector size and split output was not explicitly requested.
            let single_bin = !request.split_bin
                && layout
                    .tracks
                    .iter()
                    .all(|track| track.mode.data_bytes() == first_data_bytes);
            // The `.cue` is generated text; its size is not known without rendering it, so leave it
            // unsized (discovery only needs the patchable bin sizes).
            let mut entries = vec![ContainerListEntry {
                path: format!("{stem}.cue"),
                size: None,
            }];
            if single_bin {
                let total = layout.tracks.iter().map(track_bin_bytes).sum();
                entries.push(ContainerListEntry {
                    path: format!("{stem}.bin"),
                    size: Some(total),
                });
            } else {
                for track in &layout.tracks {
                    entries.push(ContainerListEntry {
                        path: self.track_output_name(stem, track.number),
                        size: Some(track_bin_bytes(track)),
                    });
                }
            }
            return Ok(entries);
        }
        if media_kind == ChdMediaKind::GdRom {
            let layout = self.read_disc_tracks(&chd, DiscKind::GdRom)?;
            let mut entries = vec![ContainerListEntry {
                path: format!("{stem}.gdi"),
                size: None,
            }];
            for track in &layout.tracks {
                entries.push(ContainerListEntry {
                    path: self.track_output_name(stem, track.number),
                    size: Some(track_bin_bytes(track)),
                });
            }
            return Ok(entries);
        }
        Ok(vec![ContainerListEntry {
            path: self.extract_name(&request.source, media_kind)?,
            size: Some(chd.header().logical_bytes),
        }])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        // `request.parent` is strictly the parent CHD for a differential source. Run-local
        // provenance lives on `request.containing_archive`, so a non-parented CHD nested inside an
        // archive no longer mistakes its container for a parent CHD.
        let chd = ChdReadSession::open(&request.source, request.parent.as_deref())?;
        let media_kind = chd.media_kind();
        if request.split_bin && media_kind != ChdMediaKind::CdRom {
            return Err(RomWeaverError::Validation(format!(
                "chd extract --split-bin is only supported for cd media; `{}` is {}",
                request.source.display(),
                self.media_label(media_kind)
            )));
        }
        if media_kind == ChdMediaKind::CdRom {
            return self.extract_cd(chd, request, context, execution);
        }
        if media_kind == ChdMediaKind::GdRom {
            return self.extract_gd(chd, request, context, execution);
        }
        fs::create_dir_all(&request.out_dir)?;
        let output_name = self.extract_name(&request.source, media_kind)?;
        request.ensure_single_output_selected(&output_name)?;
        let output_path = request.out_dir.join(&output_name);
        let extract_progress = self.progress_bytes_callback(
            context,
            &execution,
            "extract",
            "extract",
            chd.header().logical_bytes,
            format!("extracting `{}`", CHD.name),
        );
        // `create_output` tracks `output_path` for cleanup only after the file is
        // actually opened by this op: under `--no-overwrite` an existing target
        // makes create fail WITHOUT touching the file and never enters the guard,
        // so its Drop can't delete the very file the flag protects.
        let cleanup = ChdOutputCleanup::new();
        let mut output = BufWriter::new(cleanup.create_output(&output_path, request.overwrite)?);
        let mut output_checksum = create_extract_checksum(context)?;
        chd.stream_with_progress(
            execution.effective_threads,
            Some(&extract_progress),
            |chunk| {
                output.write_all(chunk)?;
                if let Some(checksum) = output_checksum.as_mut() {
                    checksum.update(chunk)?;
                }
                Ok(())
            },
        )?;
        output.flush()?;
        let header = chd.header();
        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(CHD.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes, {}, {})",
                request.source.display(),
                output_path.display(),
                header.logical_bytes,
                self.media_label(media_kind),
                self.header_codec_label(header)
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        let report = attach_extraction_details(report, 1, 1, header.logical_bytes, &execution);
        let mut output_checksums = Vec::new();
        push_finalized_extract_checksum(
            &mut output_checksums,
            output_path.clone(),
            output_checksum,
        )?;
        let report = attach_extract_checksum_details(report, output_checksums);
        cleanup.commit();
        Ok(attach_emitted_file_paths(report, &[output_path]))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.create_with_track_overrides(request, &[], context)
    }

    fn create_with_input_overrides(
        &self,
        request: &ContainerCreateRequest,
        overrides: &[CreateInputOverride],
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.create_with_track_overrides(request, overrides, context)
    }
}

impl ChdContainerHandler {
    /// Shared body for [`Self::create`] and the override-aware trait entry.
    /// Builds the create kind, redirects any overridden disc tracks in place
    /// via `DiscLayout::apply_input_overrides` (untouched tracks keep reading
    /// from the source disc), then streams compression. `overrides` is empty
    /// for a plain `create`.
    fn create_with_track_overrides(
        &self,
        request: &ContainerCreateRequest,
        overrides: &[CreateInputOverride],
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "chd create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let input_bytes = fs::metadata(input)?.len();
        let mode_override = self.parse_create_mode_override(&request.format)?;
        let mut create_kind = if let Some(mode) = mode_override {
            self.infer_create_kind_with_override(input, input_bytes, mode)?
        } else {
            self.infer_create_kind(input, input_bytes)?
        };
        let mut compression_plan =
            self.resolve_compression_plan(request.codec.as_deref(), &create_kind)?;
        if compression_plan.primary_codec == ChdCodec::AVHUFF {
            create_kind = match create_kind {
                ChdCreateKind::Raw => ChdCreateKind::Av(self.infer_av_profile(input, input_bytes)?),
                ChdCreateKind::Av(profile) => ChdCreateKind::Av(profile),
                _ => {
                    return Err(RomWeaverError::Validation(
                        "chd codec `avhuff` currently supports only raw `chav` frame inputs".into(),
                    ));
                }
            };
        }
        compression_plan = self.resolve_compression_plan(request.codec.as_deref(), &create_kind)?;
        compression_plan =
            self.normalize_compression_plan_for_create_kind(&create_kind, compression_plan);
        // Redirect any overridden tracks to read in place / from memory. Source
        // bytes change, not geometry, so the compression plan above still holds
        // and output stays byte-identical to a fully staged disc.
        if let ChdCreateKind::Disc(layout) = &mut create_kind {
            layout.apply_input_overrides(overrides)?;
        } else if !overrides.is_empty() {
            return Err(RomWeaverError::Validation(
                "chd create input overrides are only supported for disc layouts".into(),
            ));
        }
        // When the codec is auto-selected (no explicit `--codec`) and resolves to a
        // level-less codec such as avhuff (e.g. an auto-detected A/V stream), the
        // caller's default level profile does not apply — drop it rather than
        // rejecting. An explicit `--codec avhuff --level N` still errors.
        let level_for_codec = if request.codec.is_none()
            && !Self::codec_accepts_level(compression_plan.primary_codec)
        {
            None
        } else {
            request.level
        };
        let compression_level =
            self.resolve_compression_level(compression_plan.primary_codec, level_for_codec)?;
        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let logical_bytes = match &create_kind {
            ChdCreateKind::Disc(layout) => layout.logical_bytes()?,
            _ => input_bytes,
        };
        let create_progress = self.progress_bytes_callback(
            context,
            &execution,
            "compress",
            "create",
            logical_bytes,
            format!("creating `{}`", CHD.name),
        );

        let rust_create = || -> Result<(ChdHeader, ChdMediaKind)> {
            let header = if compression_plan.primary_codec == ChdCodec::NONE {
                if request.parent.is_some() {
                    return Err(RomWeaverError::Unsupported(
                        UnsupportedOp::ChdParentRequiresCompression,
                    ));
                }
                match &create_kind {
                    ChdCreateKind::Disc(layout) => {
                        let mut source = DiscImageReader::new(layout);
                        let source_label = format!("disc layout from `{}`", input.display());
                        self.create_uncompressed_rust_stream(
                            &mut source,
                            &source_label,
                            &request.output,
                            logical_bytes,
                            &create_kind,
                            Some(&create_progress),
                        )?
                    }
                    _ => self.create_uncompressed_rust_raw(
                        input,
                        &request.output,
                        logical_bytes,
                        &create_kind,
                        Some(&create_progress),
                    )?,
                }
            } else {
                match &create_kind {
                    ChdCreateKind::Disc(layout) => {
                        let mut source = DiscImageReader::new(layout);
                        let source_label = format!("disc layout from `{}`", input.display());
                        self.create_compressed_rust_stream(
                            &mut source,
                            &source_label,
                            CompressedCreateParams {
                                output: &request.output,
                                logical_bytes,
                                create_kind: &create_kind,
                                codecs: compression_plan.codecs,
                                compression_level,
                                thread_count: execution.effective_threads,
                                parent_source: request.parent.as_deref(),
                                on_progress: Some(&create_progress),
                            },
                        )?
                    }
                    _ => self.create_compressed_rust_raw(
                        input,
                        CompressedCreateParams {
                            output: &request.output,
                            logical_bytes,
                            create_kind: &create_kind,
                            codecs: compression_plan.codecs,
                            compression_level,
                            thread_count: execution.effective_threads,
                            parent_source: request.parent.as_deref(),
                            on_progress: Some(&create_progress),
                        },
                    )?,
                }
            };
            Ok((header, self.media_kind_from_create_kind(&create_kind)))
        };

        let should_attempt_rust = self.should_attempt_rust_create(
            &create_kind,
            compression_plan.codecs,
            compression_plan.primary_codec,
        );
        // Both create paths write `request.output` incrementally (a placeholder
        // header first, then hunks/map): remove the partial file if any step
        // fails so a corrupt/placeholder CHD is not left behind. Track the output
        // only once we commit to the attempt AND only when it does not already
        // exist — a pre-open error (unsupported codec plan, store+parent, invalid
        // geometry) never opens the file via `File::create`, so it must not
        // delete an unrelated pre-existing target this op never created.
        let guard_output = should_attempt_rust && !request.output.exists();
        trace!(
            output = %request.output.display(),
            should_attempt_rust,
            guard_output,
            "arming chd create output cleanup guard"
        );
        let cleanup = ChdOutputCleanup::new();
        if guard_output {
            cleanup.track(request.output.clone());
        }
        let (header, media_kind) = if !should_attempt_rust {
            Err(RomWeaverError::Unsupported(
                UnsupportedOp::ChdCodecListInvalid {
                    media: self
                        .media_label(self.media_kind_from_create_kind(&create_kind))
                        .to_string(),
                },
            ))
        } else {
            rust_create()
        }?;
        cleanup.commit();

        let mut report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(CHD.name.to_string()),
            "create",
            format!(
                "created {} chd `{}` from `{}` ({} bytes, {})",
                self.media_label(media_kind),
                request.output.display(),
                input.display(),
                header.logical_bytes,
                self.header_codec_label(header)
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        let codecs = compression_plan
            .codecs
            .into_iter()
            .filter(|codec| *codec != ChdCodec::NONE)
            .map(|codec| self.codec_label(codec).to_string())
            .collect::<Vec<_>>();
        let codec_label = if codecs.is_empty() {
            "store".to_string()
        } else {
            codecs.join("+")
        };
        let mut details = operation_report_details(&mut report);
        let mut compression = Map::new();
        compression.insert("codec".to_string(), json!(codec_label));
        compression.insert(
            "primary_codec".to_string(),
            json!(self.codec_label(compression_plan.primary_codec)),
        );
        compression.insert("codecs".to_string(), json!(codecs));
        compression.insert("level".to_string(), json!(compression_level));
        compression.insert("logical_bytes".to_string(), json!(header.logical_bytes));
        insert_thread_execution_details(&mut compression, &execution);
        details.insert("compression".to_string(), Value::Object(compression));
        report.details = Some(Value::Object(details));
        Ok(report)
    }
}
