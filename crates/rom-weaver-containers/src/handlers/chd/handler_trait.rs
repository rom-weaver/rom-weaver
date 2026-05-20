    impl ContainerHandler for ChdContainerHandler {
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
            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "inspect",
                format!(
                    "{} chd v{}: {} bytes, {}-byte hunks, codec={}",
                    self.media_label(media_kind),
                    header.version,
                    header.logical_bytes,
                    header.hunk_bytes,
                    self.header_codec_label(header)
                ),
                Some(100.0),
                Some(execution),
            ))
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
                return self.extract_cd(chd, request, execution);
            }
            if media_kind == ChdMediaKind::GdRom {
                return self.extract_gd(chd, request, execution);
            }
            fs::create_dir_all(&request.out_dir)?;
            let output_name = self.extract_name(&request.source, media_kind)?;
            let mut selections = SelectionMatcher::new(&request.selections);
            if !selections.matches(&output_name) {
                selections.ensure_all_matched()?;
            }
            selections.ensure_all_matched()?;
            let output_path = request.out_dir.join(&output_name);
            let header = chd.extract_to_file(&output_path, execution.effective_threads)?;
            Ok(OperationReport::succeeded(
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
            ))
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
                    ChdCreateKind::Raw => {
                        ChdCreateKind::Av(self.infer_av_profile(input, input_bytes)?)
                    }
                    ChdCreateKind::Av(profile) => ChdCreateKind::Av(profile),
                    _ => {
                        return Err(RomWeaverError::Validation(
                            "chd codec `avhuff` currently supports only raw `chav` frame inputs"
                                .into(),
                        ));
                    }
                };
            }
            compression_plan =
                self.resolve_compression_plan(request.codec.as_deref(), &create_kind)?;
            compression_plan =
                self.normalize_compression_plan_for_create_kind(&create_kind, compression_plan);
            let compression_level =
                self.resolve_compression_level(compression_plan.primary_codec, request.level)?;
            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }

            let mut staged_input = None;
            let (source_path, logical_bytes) = match &create_kind {
                ChdCreateKind::Disc(layout) => {
                    let temp_path = self.materialize_disc_image(layout)?;
                    let logical_bytes = fs::metadata(&temp_path)?.len();
                    staged_input = Some(temp_path);
                    (
                        staged_input.as_ref().expect("staged disc input"),
                        logical_bytes,
                    )
                }
                _ => (input, input_bytes),
            };

            let rust_create = || -> Result<(ChdHeader, ChdMediaKind)> {
                let header = if compression_plan.primary_codec == ChdCodec::NONE {
                    if request.parent.is_some() {
                        return Err(RomWeaverError::Unsupported(
                            "chd create with parent requires at least one compressed codec; `store` mode cannot reference parent hunks"
                                .to_string(),
                        ));
                    }
                    self.create_uncompressed_rust_raw(
                        source_path,
                        &request.output,
                        logical_bytes,
                        &create_kind,
                    )?
                } else {
                    self.create_compressed_rust_raw(
                        source_path,
                        &request.output,
                        logical_bytes,
                        &create_kind,
                        compression_plan.codecs,
                        compression_level,
                        execution.effective_threads,
                        request.parent.as_deref(),
                    )?
                };
                Ok((header, self.media_kind_from_create_kind(&create_kind)))
            };

            let should_attempt_rust = self.should_attempt_rust_create(
                &create_kind,
                compression_plan.codecs,
                compression_plan.primary_codec,
            );
            let create_result = if !should_attempt_rust {
                Err(RomWeaverError::Unsupported(format!(
                    "chd codec list is invalid for {} media",
                    self.media_label(self.media_kind_from_create_kind(&create_kind))
                )))
            } else {
                rust_create()
            };
            if let Some(path) = staged_input.as_ref() {
                let _ = fs::remove_file(path);
            }
            let (header, media_kind) = create_result?;

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

        fn capabilities(&self) -> ContainerCapabilities {
            ContainerCapabilities {
                inspect: true,
                extract: true,
                create: true,
                extract_threads: ThreadCapability::parallel(None),
                create_threads: ThreadCapability::parallel(None),
            }
        }
    }
