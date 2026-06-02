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

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
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
            "inspect",
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
        if sha1.is_some() || raw_sha1.is_some() {
            let mut details = Map::new();
            let mut chd_details = Map::new();
            if let Some(sha1) = sha1 {
                chd_details.insert("sha1".to_string(), json!(sha1));
            }
            if let Some(raw_sha1) = raw_sha1 {
                chd_details.insert("raw_sha1".to_string(), json!(raw_sha1));
            }
            details.insert("chd".to_string(), Value::Object(chd_details));
            report.details = Some(Value::Object(details));
        }
        Ok(report)
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
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

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
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
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;
        let output_path = request.out_dir.join(&output_name);
        let extract_progress = self.progress_bytes_callback(
            context,
            &execution,
            "extract",
            "extract",
            chd.header().logical_bytes,
            format!("extracting `{}`", CHD.name),
        );
        let mut output =
            BufWriter::new(create_extract_output_file(&output_path, request.overwrite)?);
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
            Some(execution),
        );
        let mut output_checksums = Vec::new();
        push_finalized_extract_checksum(&mut output_checksums, output_path, output_checksum)?;
        Ok(attach_extract_checksum_details(report, output_checksums))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
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
        let compression_level =
            self.resolve_compression_level(compression_plan.primary_codec, request.level)?;
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
                            "chd create with parent requires at least one compressed codec; `store` mode cannot reference parent hunks"
                                .to_string(),
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
        let (header, media_kind) = if !should_attempt_rust {
            Err(RomWeaverError::Unsupported(format!(
                "chd codec list is invalid for {} media",
                self.media_label(self.media_kind_from_create_kind(&create_kind))
            )))
        } else {
            rust_create()
        }?;

        Ok(OperationReport::succeeded(
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
            Some(execution),
        ))
    }
}
