    impl ChdContainerHandler {
        fn parse_cue_file(&self, path: &Path) -> Result<DiscLayout> {
            #[derive(Clone, Debug)]
            struct PendingTrack {
                number: u32,
                mode: DiscTrackMode,
                file_path: PathBuf,
                file_offset_base_bytes: u64,
                file_data_len_bytes: u64,
                index00_frames: Option<u32>,
                index01_frames: Option<u32>,
                pregap_frames: u32,
                postgap_frames: u32,
                swap_audio_on_read: bool,
            }

            #[derive(Clone, Debug)]
            struct PendingFile {
                path: PathBuf,
                data_offset_bytes: u64,
                data_len_bytes: u64,
                swap_audio_on_read: bool,
            }

            let cue_dir = path.parent().unwrap_or_else(|| Path::new("."));
            let mut cue_reader = BufReader::new(File::open(path)?);
            let mut tracks = Vec::<PendingTrack>::new();
            let mut current_file: Option<PendingFile> = None;
            let mut current_track: Option<usize> = None;

            let mut raw_line = String::new();
            loop {
                raw_line.clear();
                if cue_reader.read_line(&mut raw_line)? == 0 {
                    break;
                }
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                let keyword_end = line.find(char::is_whitespace).unwrap_or(line.len());
                let keyword = line[..keyword_end].to_ascii_uppercase();
                let remainder = line[keyword_end..].trim_start();
                match keyword.as_str() {
                    "REM" | "TITLE" | "PERFORMER" | "SONGWRITER" | "FLAGS" | "CATALOG" | "ISRC" => {
                    }
                    "FILE" => {
                        let (name, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid FILE entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (kind, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing FILE type in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let full_path = cue_dir.join(name);
                        let kind = kind.trim().to_ascii_uppercase();
                        current_file = Some(match kind.as_str() {
                            "BINARY" => PendingFile {
                                path: full_path.clone(),
                                data_offset_bytes: 0,
                                data_len_bytes: fs::metadata(&full_path)?.len(),
                                swap_audio_on_read: true,
                            },
                            "MOTOROLA" => PendingFile {
                                path: full_path.clone(),
                                data_offset_bytes: 0,
                                data_len_bytes: fs::metadata(&full_path)?.len(),
                                swap_audio_on_read: false,
                            },
                            "WAVE" => {
                                let (data_offset_bytes, data_len_bytes) =
                                    self.parse_wave_file(&full_path)?;
                                PendingFile {
                                    path: full_path,
                                    data_offset_bytes,
                                    data_len_bytes,
                                    swap_audio_on_read: true,
                                }
                            }
                            other => {
                                return Err(RomWeaverError::Validation(format!(
                                    "cue `{}` uses FILE type `{other}`; current chd cue support accepts BINARY, MOTOROLA, and WAVE files",
                                    path.display()
                                )));
                            }
                        });
                        current_track = None;
                    }
                    "TRACK" => {
                        let Some(file) = current_file.clone() else {
                            return Err(RomWeaverError::Validation(format!(
                                "TRACK entry appeared before FILE in cue `{}`",
                                path.display()
                            )));
                        };
                        let (number, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid TRACK entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (mode, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing TRACK type in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let number = number.parse::<u32>().map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "invalid TRACK number `{number}` in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let mode = self.parse_disc_mode(mode)?;
                        if file.data_offset_bytes != 0 && mode != DiscTrackMode::Audio {
                            return Err(RomWeaverError::Validation(format!(
                                "cue `{}` uses a WAVE file for non-audio track {}",
                                path.display(),
                                number
                            )));
                        }
                        tracks.push(PendingTrack {
                            number,
                            mode,
                            file_path: file.path.clone(),
                            file_offset_base_bytes: file.data_offset_bytes,
                            file_data_len_bytes: file.data_len_bytes,
                            index00_frames: None,
                            index01_frames: None,
                            pregap_frames: 0,
                            postgap_frames: 0,
                            swap_audio_on_read: file.swap_audio_on_read,
                        });
                        current_track = Some(tracks.len() - 1);
                    }
                    "INDEX" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "INDEX entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        let (index_number, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid INDEX entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (time, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing INDEX time in cue `{}`",
                                path.display()
                            ))
                        })?;
                        match index_number {
                            "00" => {
                                tracks[track_index].index00_frames = Some(self.parse_msf(time)?)
                            }
                            "01" => {
                                tracks[track_index].index01_frames = Some(self.parse_msf(time)?)
                            }
                            other => {
                                return Err(RomWeaverError::Validation(format!(
                                    "cue `{}` uses unsupported index `{other}`; current chd cue support accepts INDEX 00 and INDEX 01",
                                    path.display()
                                )));
                            }
                        }
                    }
                    "PREGAP" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "PREGAP entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        tracks[track_index].pregap_frames = self.parse_msf(remainder)?;
                    }
                    "POSTGAP" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "POSTGAP entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        tracks[track_index].postgap_frames = self.parse_msf(remainder)?;
                    }
                    other => {
                        return Err(RomWeaverError::Validation(format!(
                            "cue `{}` uses unsupported directive `{other}`",
                            path.display()
                        )));
                    }
                }
            }

            if tracks.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "cue `{}` did not define any tracks",
                    path.display()
                )));
            }

            let mut resolved = Vec::with_capacity(tracks.len());
            for (index, track) in tracks.iter().enumerate() {
                let index01_frames = track.index01_frames.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "cue track {} in `{}` is missing INDEX 01",
                        track.number,
                        path.display()
                    ))
                })?;
                if track.pregap_frames > 0 && track.index00_frames.is_some() {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} in `{}` uses both INDEX 00 and PREGAP; current chd cue support requires one pregap style",
                        track.number,
                        path.display()
                    )));
                }
                let start_frame = track.index00_frames.unwrap_or(index01_frames);
                let sector_bytes = u64::try_from(track.mode.data_bytes()).unwrap_or(2352);
                let start = track.file_offset_base_bytes + u64::from(start_frame) * sector_bytes;
                let file_end = track.file_offset_base_bytes + track.file_data_len_bytes;
                if start > file_end {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} starts past the end of `{}`",
                        track.number,
                        track.file_path.display()
                    )));
                }
                let mut next_start = file_end;
                for candidate in &tracks[index + 1..] {
                    if candidate.file_path != track.file_path
                        || candidate.file_offset_base_bytes != track.file_offset_base_bytes
                    {
                        continue;
                    }
                    if candidate.mode.data_bytes() != track.mode.data_bytes() {
                        return Err(RomWeaverError::Validation(format!(
                            "cue `{}` shares `{}` across tracks with different sector sizes; current chd cue support requires a separate file per sector size",
                            path.display(),
                            track.file_path.display()
                        )));
                    }
                    let candidate_index01 = candidate.index01_frames.ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "cue track {} in `{}` is missing INDEX 01",
                            candidate.number,
                            path.display()
                        ))
                    })?;
                    let candidate_start_frame =
                        candidate.index00_frames.unwrap_or(candidate_index01);
                    next_start = candidate.file_offset_base_bytes
                        + u64::from(candidate_start_frame) * sector_bytes;
                    break;
                }
                if next_start < start {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} has descending frame offsets in `{}`",
                        track.number,
                        path.display()
                    )));
                }
                let byte_len = next_start - start;
                if byte_len % sector_bytes != 0 {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} length in `{}` is not divisible by {} bytes",
                        track.number,
                        track.file_path.display(),
                        sector_bytes
                    )));
                }
                let frames = u32::try_from(byte_len / sector_bytes).map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "cue track {} is too large for current chd cd support",
                        track.number
                    ))
                })?;
                let pregap_from_index = index01_frames.saturating_sub(start_frame);
                let pregap_has_data = track.index00_frames.is_some() && pregap_from_index > 0;
                let pregap_frames = if pregap_has_data {
                    pregap_from_index
                } else {
                    track.pregap_frames
                };
                resolved.push(DiscTrack {
                    number: track.number,
                    mode: track.mode,
                    file_path: track.file_path.clone(),
                    file_offset_bytes: start,
                    frames,
                    pregap_frames,
                    postgap_frames: track.postgap_frames,
                    pregap_has_data,
                    has_subcode: false,
                    pad_frames: 0,
                    swap_audio_on_read: track.swap_audio_on_read,
                });
            }

            Ok(DiscLayout {
                kind: DiscKind::CdRom,
                tracks: resolved,
            })
        }

        fn parse_gdi_file(&self, path: &Path) -> Result<DiscLayout> {
            #[derive(Clone, Debug)]
            struct PendingTrack {
                number: u32,
                physframeofs: u32,
                mode: DiscTrackMode,
                file_path: PathBuf,
                file_offset_bytes: u64,
                data_frames: u32,
                swap_audio_on_read: bool,
            }

            let gdi_dir = path.parent().unwrap_or_else(|| Path::new("."));
            let mut gdi_reader = BufReader::new(File::open(path)?);
            let mut raw_line = String::new();
            let mut track_count = None::<usize>;
            let mut tracks = Vec::new();
            loop {
                raw_line.clear();
                if gdi_reader.read_line(&mut raw_line)? == 0 {
                    break;
                }
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                if track_count.is_none() {
                    let parsed_track_count = line.parse::<usize>().map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "gdi `{}` has an invalid track count header",
                            path.display()
                        ))
                    })?;
                    if parsed_track_count == 0 {
                        return Err(RomWeaverError::Validation(format!(
                            "gdi `{}` does not define any tracks",
                            path.display()
                        )));
                    }
                    track_count = Some(parsed_track_count);
                    tracks = Vec::with_capacity(parsed_track_count);
                    continue;
                }

                let (number, remainder) = split_token(line).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid gdi track entry in `{}`",
                        path.display()
                    ))
                })?;
                let (physframeofs, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its physical offset",
                        path.display()
                    ))
                })?;
                let (track_type, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its track type",
                        path.display()
                    ))
                })?;
                let (sector_size, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its sector size",
                        path.display()
                    ))
                })?;
                let (name, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its filename",
                        path.display()
                    ))
                })?;
                let (file_offset, _) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its file offset",
                        path.display()
                    ))
                })?;

                let number = number.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track number `{number}`",
                        path.display()
                    ))
                })?;
                let physframeofs = physframeofs.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid physical offset `{physframeofs}`",
                        path.display()
                    ))
                })?;
                let track_type = track_type.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track type `{track_type}`",
                        path.display()
                    ))
                })?;
                let sector_size = sector_size.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid sector size `{sector_size}`",
                        path.display()
                    ))
                })?;
                let file_offset_bytes = file_offset.parse::<u64>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid file offset `{file_offset}`",
                        path.display()
                    ))
                })?;

                let (mode, swap_audio_on_read) = match (track_type, sector_size) {
                    (4, 2352) => (DiscTrackMode::Mode1Raw, false),
                    (4, 2048) => (DiscTrackMode::Mode1, false),
                    (0, 2352) => (DiscTrackMode::Audio, true),
                    _ => {
                        return Err(RomWeaverError::Validation(format!(
                            "gdi `{}` uses unsupported track type/sector-size pair `{track_type}/{sector_size}`",
                            path.display()
                        )));
                    }
                };

                let file_path = gdi_dir.join(name);
                let file_size = fs::metadata(&file_path)?.len();
                if file_offset_bytes > file_size {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi track {} starts past the end of `{}`",
                        number,
                        file_path.display()
                    )));
                }
                let payload_bytes = file_size - file_offset_bytes;
                if payload_bytes % u64::from(sector_size) != 0 {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi track {} length in `{}` is not divisible by {} bytes",
                        number,
                        file_path.display(),
                        sector_size
                    )));
                }
                let data_frames =
                    u32::try_from(payload_bytes / u64::from(sector_size)).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "gdi track {} is too large for current chd gd-rom support",
                            number
                        ))
                    })?;

                tracks.push(PendingTrack {
                    number,
                    physframeofs,
                    mode,
                    file_path,
                    file_offset_bytes,
                    data_frames,
                    swap_audio_on_read,
                });
            }

            let track_count = track_count.ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "gdi `{}` is missing its track count header",
                    path.display()
                ))
            })?;

            if tracks.len() != track_count {
                return Err(RomWeaverError::Validation(format!(
                    "gdi `{}` declared {} tracks but defined {}",
                    path.display(),
                    track_count,
                    tracks.len()
                )));
            }

            tracks.sort_by_key(|track| track.number);
            for (index, track) in tracks.iter().enumerate() {
                let expected = u32::try_from(index + 1).unwrap_or(u32::MAX);
                if track.number != expected {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi `{}` is missing track {}",
                        path.display(),
                        expected
                    )));
                }
            }

            let mut resolved = Vec::with_capacity(tracks.len());
            for (index, track) in tracks.iter().enumerate() {
                let next_physframeofs = tracks
                    .get(index + 1)
                    .map(|candidate| candidate.physframeofs);
                let pad_frames = next_physframeofs
                    .map(|next| {
                        next.checked_sub(track.physframeofs.saturating_add(track.data_frames))
                            .ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "gdi track {} overlaps the next track in `{}`",
                                    track.number,
                                    path.display()
                                ))
                            })
                    })
                    .transpose()?
                    .unwrap_or(0);

                resolved.push(DiscTrack {
                    number: track.number,
                    mode: track.mode,
                    file_path: track.file_path.clone(),
                    file_offset_bytes: track.file_offset_bytes,
                    frames: track.data_frames.saturating_add(pad_frames),
                    pregap_frames: 0,
                    postgap_frames: 0,
                    pregap_has_data: false,
                    has_subcode: false,
                    pad_frames,
                    swap_audio_on_read: track.swap_audio_on_read,
                });
            }

            Ok(DiscLayout {
                kind: DiscKind::GdRom,
                tracks: resolved,
            })
        }

        fn read_disc_tracks(&self, chd: &ChdReadSession, kind: DiscKind) -> Result<DiscLayout> {
            let mut tracks = Vec::new();
            for index in 0..99_u32 {
                let Some(metadata) = chd.read_metadata(kind.metadata_tag(), index)? else {
                    break;
                };
                let text = String::from_utf8_lossy(&metadata)
                    .trim_end_matches('\0')
                    .to_string();
                let mut number = None;
                let mut mode = None;
                let mut subtype = None;
                let mut frames = None;
                let mut pad_frames = 0_u32;
                let mut pregap = 0_u32;
                let mut pgtype = String::new();
                let mut postgap = 0_u32;

                for field in text.split_whitespace() {
                    let Some((key, value)) = field.split_once(':') else {
                        continue;
                    };
                    match key {
                        "TRACK" => number = value.parse::<u32>().ok(),
                        "TYPE" => mode = Some(self.parse_disc_mode(value)?),
                        "SUBTYPE" => subtype = Some(value.to_ascii_uppercase()),
                        "FRAMES" => frames = value.parse::<u32>().ok(),
                        "PAD" => pad_frames = value.parse::<u32>().unwrap_or(0),
                        "PREGAP" => pregap = value.parse::<u32>().unwrap_or(0),
                        "PGTYPE" => pgtype = value.to_string(),
                        "POSTGAP" => postgap = value.parse::<u32>().unwrap_or(0),
                        _ => {}
                    }
                }

                let number = number.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing track number"
                    ))
                })?;
                let mode = mode.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing track type"
                    ))
                })?;
                let frames = frames.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing frame count"
                    ))
                })?;
                let subtype = subtype.unwrap_or_else(|| "NONE".to_string());
                tracks.push(DiscTrack {
                    number,
                    mode,
                    file_path: PathBuf::new(),
                    file_offset_bytes: 0,
                    frames,
                    pregap_frames: pregap,
                    postgap_frames: postgap,
                    pregap_has_data: pgtype.starts_with('V'),
                    has_subcode: subtype != "NONE",
                    pad_frames,
                    swap_audio_on_read: false,
                });
            }

            if tracks.is_empty() {
                return Err(RomWeaverError::Validation(
                    match kind {
                        DiscKind::CdRom => "cd chd is missing CD track metadata",
                        DiscKind::GdRom => "gd chd is missing GD track metadata",
                    }
                    .into(),
                ));
            }

            Ok(DiscLayout { kind, tracks })
        }

        fn create_temp_file_path(&self, stem: &str, extension: &str) -> PathBuf {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default();
            Self::runtime_temp_dir().join(format!(
                "rom-weaver-{stem}-{}-{timestamp}{extension}",
                Self::runtime_process_id()
            ))
        }

        fn runtime_temp_dir() -> PathBuf {
            #[cfg(target_family = "wasm")]
            {
                if let Some(path) = std::env::var_os("ROM_WEAVER_TMPDIR")
                    && !path.is_empty()
                {
                    return PathBuf::from(path);
                }

                return PathBuf::from("/tmp");
            }

            #[cfg(not(target_family = "wasm"))]
            {
                std::env::temp_dir()
            }
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

        fn track_output_name(&self, stem: &str, track_number: u32) -> String {
            format!("{stem}.track{track_number:02}.bin")
        }

        fn materialize_disc_image(&self, layout: &DiscLayout) -> Result<PathBuf> {
            let temp_path = self.create_temp_file_path(
                match layout.kind {
                    DiscKind::CdRom => "cd-input",
                    DiscKind::GdRom => "gd-input",
                },
                ".bin",
            );
            let mut writer = BufWriter::new(File::create(&temp_path)?);
            let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
            let zero_frame = frame.clone();

            for track in &layout.tracks {
                let mut reader = BufReader::new(File::open(&track.file_path)?);
                reader.seek(SeekFrom::Start(track.file_offset_bytes))?;
                let mut data = vec![0_u8; track.mode.data_bytes()];
                let data_frames = track.frames.saturating_sub(track.pad_frames);
                for _ in 0..data_frames {
                    reader.read_exact(&mut data)?;
                    if track.swap_audio_on_read {
                        track.mode.swap_audio_bytes(&mut data);
                    }
                    frame.fill(0);
                    frame[..data.len()].copy_from_slice(&data);
                    writer.write_all(&frame)?;
                }
                for _ in 0..track.pad_frames {
                    writer.write_all(&zero_frame)?;
                }
            }

            writer.flush()?;
            Ok(temp_path)
        }

        fn extract_cd(
            &self,
            chd: ChdReadSession,
            request: &ContainerExtractRequest,
            execution: rom_weaver_core::ThreadExecution,
        ) -> Result<OperationReport> {
            let header = chd.header();
            if header.unit_bytes != Self::CD_FRAME_BYTES {
                return Err(RomWeaverError::Validation(format!(
                    "cd chd uses {}-byte units; current extract expects {}-byte frames",
                    header.unit_bytes,
                    Self::CD_FRAME_BYTES
                )));
            }

            let layout = self.read_disc_tracks(&chd, DiscKind::CdRom)?;
            fs::create_dir_all(&request.out_dir)?;
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            let cue_path = request.out_dir.join(format!("{stem}.cue"));
            let temp_path = self.create_temp_file_path("cd-extract", ".bin");
            let extract_result = chd.extract_to_file(&temp_path, execution.effective_threads);
            if extract_result.is_err() {
                let _ = fs::remove_file(&temp_path);
            }
            let _ = extract_result?;

            let first_data_bytes = layout
                .tracks
                .first()
                .map(|track| track.mode.data_bytes())
                .unwrap_or(2352);
            let natural_single_bin = layout
                .tracks
                .iter()
                .all(|track| track.mode.data_bytes() == first_data_bytes);
            let single_bin = natural_single_bin && !request.split_bin;
            let selection_requested = !request.selections.is_empty();
            let cue_name = format!("{stem}.cue");
            let mut selections = SelectionMatcher::new(&request.selections);
            let write_cue = selections.matches(&cue_name);
            let single_bin_name = format!("{stem}.bin");
            let mut write_single_bin = single_bin && selections.matches(&single_bin_name);
            let mut split_track_names = Vec::new();
            let mut write_split_tracks = Vec::new();
            if !single_bin {
                for track in &layout.tracks {
                    let track_name = self.track_output_name(stem, track.number);
                    write_split_tracks.push(selections.matches(&track_name));
                    split_track_names.push(track_name);
                }
            }
            if selection_requested && write_cue {
                let any_selected = if single_bin {
                    write_single_bin
                } else {
                    write_split_tracks.iter().any(|selected| *selected)
                };
                if !any_selected {
                    if single_bin {
                        write_single_bin = true;
                    } else {
                        for selected in &mut write_split_tracks {
                            *selected = true;
                        }
                    }
                }
            }
            selections.ensure_all_matched()?;

            let build_result: Result<(bool, Vec<PathBuf>, bool)> = (|| {
                let mut reader = BufReader::new(File::open(&temp_path)?);
                let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
                let mut omitted_subcode = false;
                let mut produced_outputs = Vec::new();
                let mut cue_writer = if write_cue {
                    produced_outputs.push(cue_path.clone());
                    Some(BufWriter::new(File::create(&cue_path)?))
                } else {
                    None
                };
                let mut wrote_single_bin_output = false;

                if single_bin {
                    let bin_path = request.out_dir.join(&single_bin_name);
                    let mut bin_writer = if write_single_bin {
                        wrote_single_bin_output = true;
                        produced_outputs.push(bin_path.clone());
                        Some(BufWriter::new(File::create(&bin_path)?))
                    } else {
                        None
                    };
                    if let Some(writer) = cue_writer.as_mut() {
                        writer
                            .write_all(format!("FILE \"{single_bin_name}\" BINARY\n").as_bytes())?;
                    }
                    let mut output_frame_offset = 0_u32;
                    for track in &layout.tracks {
                        if let Some(writer) = cue_writer.as_mut() {
                            writer.write_all(
                                format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label())
                                    .as_bytes(),
                            )?;
                            if track.pregap_frames > 0 && track.pregap_has_data {
                                writer.write_all(
                                    format!(
                                        "    INDEX 00 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset + track.pregap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                            } else if track.pregap_frames > 0 {
                                writer.write_all(
                                    format!(
                                        "    PREGAP {}\n",
                                        self.format_msf(track.pregap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                            } else {
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                            }
                            if track.postgap_frames > 0 {
                                writer.write_all(
                                    format!(
                                        "    POSTGAP {}\n",
                                        self.format_msf(track.postgap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                            }
                        }

                        let data_frames = track.frames.saturating_sub(track.pad_frames);
                        for _ in 0..data_frames {
                            reader.read_exact(&mut frame)?;
                            let data = &mut frame[..track.mode.data_bytes()];
                            if write_single_bin && track.has_subcode {
                                omitted_subcode = true;
                            }
                            track.mode.swap_audio_bytes(data);
                            if let Some(writer) = bin_writer.as_mut() {
                                writer.write_all(data)?;
                            }
                        }
                        for _ in 0..track.pad_frames {
                            reader.read_exact(&mut frame)?;
                        }
                        output_frame_offset = output_frame_offset.saturating_add(data_frames);
                    }
                    if let Some(writer) = bin_writer.as_mut() {
                        writer.flush()?;
                    }
                } else {
                    for (track_index, track) in layout.tracks.iter().enumerate() {
                        let track_name = &split_track_names[track_index];
                        let track_selected = write_split_tracks[track_index];
                        let track_path = request.out_dir.join(track_name);
                        if let Some(writer) = cue_writer.as_mut() {
                            if track_selected {
                                writer.write_all(
                                    format!("FILE \"{track_name}\" BINARY\n").as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "  TRACK {:02} {}\n",
                                        track.number,
                                        track.mode.cue_label()
                                    )
                                    .as_bytes(),
                                )?;
                                if track.pregap_frames > 0 && track.pregap_has_data {
                                    writer.write_all(b"    INDEX 00 00:00:00\n")?;
                                    writer.write_all(
                                        format!(
                                            "    INDEX 01 {}\n",
                                            self.format_msf(track.pregap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                } else if track.pregap_frames > 0 {
                                    writer.write_all(
                                        format!(
                                            "    PREGAP {}\n",
                                            self.format_msf(track.pregap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                                } else {
                                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                                }
                                if track.postgap_frames > 0 {
                                    writer.write_all(
                                        format!(
                                            "    POSTGAP {}\n",
                                            self.format_msf(track.postgap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                }
                            }
                        }

                        let mut track_writer = if track_selected {
                            produced_outputs.push(track_path.clone());
                            Some(BufWriter::new(File::create(track_path)?))
                        } else {
                            None
                        };
                        let data_frames = track.frames.saturating_sub(track.pad_frames);
                        for _ in 0..data_frames {
                            reader.read_exact(&mut frame)?;
                            let data = &mut frame[..track.mode.data_bytes()];
                            if track_selected && track.has_subcode {
                                omitted_subcode = true;
                            }
                            track.mode.swap_audio_bytes(data);
                            if let Some(writer) = track_writer.as_mut() {
                                writer.write_all(data)?;
                            }
                        }
                        for _ in 0..track.pad_frames {
                            reader.read_exact(&mut frame)?;
                        }
                        if let Some(writer) = track_writer.as_mut() {
                            writer.flush()?;
                        }
                    }
                }

                if let Some(writer) = cue_writer.as_mut() {
                    writer.flush()?;
                }
                Ok((omitted_subcode, produced_outputs, wrote_single_bin_output))
            })();

            let _ = fs::remove_file(&temp_path);
            let (omitted_subcode, produced_outputs, wrote_single_bin_output) = build_result?;
            if selection_requested && produced_outputs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "requested selections resolved to no extractable cd outputs".into(),
                ));
            }
            let suffix = if omitted_subcode {
                "; subcode data was omitted from cue/bin output"
            } else {
                ""
            };

            let split_bin_suffix = if request.split_bin {
                let emitted_files = produced_outputs
                    .iter()
                    .map(|path| {
                        path.strip_prefix(&request.out_dir)
                            .unwrap_or(path.as_path())
                            .to_string_lossy()
                            .replace('\\', "/")
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("; splitbin=true emitted_files={emitted_files}")
            } else {
                String::new()
            };

            let label = if !selection_requested && wrote_single_bin_output {
                let bin_path = request.out_dir.join(&single_bin_name);
                format!(
                    "extracted `{}` to `{}` and `{}` (cd, {}){}{}",
                    request.source.display(),
                    cue_path.display(),
                    bin_path.display(),
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            } else if !selection_requested {
                format!(
                    "extracted `{}` to `{}` and per-track bin files (cd, {}){}{}",
                    request.source.display(),
                    cue_path.display(),
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            } else {
                let outputs = produced_outputs
                    .iter()
                    .map(|path| format!("`{}`", path.display()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "extracted `{}` to selected outputs: {} (cd, {}){}{}",
                    request.source.display(),
                    outputs,
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            };

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                label,
                Some(100.0),
                Some(execution),
            ))
        }

        fn extract_gd(
            &self,
            chd: ChdReadSession,
            request: &ContainerExtractRequest,
            execution: rom_weaver_core::ThreadExecution,
        ) -> Result<OperationReport> {
            let header = chd.header();
            if header.unit_bytes != Self::CD_FRAME_BYTES {
                return Err(RomWeaverError::Validation(format!(
                    "gd chd uses {}-byte units; current extract expects {}-byte frames",
                    header.unit_bytes,
                    Self::CD_FRAME_BYTES
                )));
            }

            let layout = self.read_disc_tracks(&chd, DiscKind::GdRom)?;
            fs::create_dir_all(&request.out_dir)?;
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            let gdi_path = request.out_dir.join(format!("{stem}.gdi"));
            let temp_path = self.create_temp_file_path("gd-extract", ".bin");
            let extract_result = chd.extract_to_file(&temp_path, execution.effective_threads);
            if extract_result.is_err() {
                let _ = fs::remove_file(&temp_path);
            }
            let _ = extract_result?;

            let selection_requested = !request.selections.is_empty();
            let gdi_name = format!("{stem}.gdi");
            let mut selections = SelectionMatcher::new(&request.selections);
            let write_gdi = selections.matches(&gdi_name);
            let mut track_names = Vec::with_capacity(layout.tracks.len());
            let mut write_tracks = Vec::with_capacity(layout.tracks.len());
            for track in &layout.tracks {
                let track_name = self.track_output_name(stem, track.number);
                write_tracks.push(selections.matches(&track_name));
                track_names.push(track_name);
            }
            if selection_requested && write_gdi && !write_tracks.iter().any(|selected| *selected) {
                for selected in &mut write_tracks {
                    *selected = true;
                }
            }
            selections.ensure_all_matched()?;

            let build_result: Result<(bool, Vec<PathBuf>)> = (|| {
                let mut reader = BufReader::new(File::open(&temp_path)?);
                let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
                let mut omitted_subcode = false;
                let mut physframeofs = 0_u32;
                let mut produced_outputs = Vec::new();
                let mut gdi_lines = Vec::new();

                for (track_index, track) in layout.tracks.iter().enumerate() {
                    let (track_type, sector_size) = track.mode.gdi_track_descriptor()?;
                    let track_name = &track_names[track_index];
                    let track_selected = write_tracks[track_index];
                    if track_selected {
                        gdi_lines.push(format!(
                            "{} {} {} {} {} 0",
                            track.number, physframeofs, track_type, sector_size, track_name
                        ));
                    }
                    let track_path = request.out_dir.join(track_name);
                    let mut track_writer = if track_selected {
                        produced_outputs.push(track_path.clone());
                        Some(BufWriter::new(File::create(track_path)?))
                    } else {
                        None
                    };
                    let data_frames = track.frames.saturating_sub(track.pad_frames);
                    for _ in 0..data_frames {
                        reader.read_exact(&mut frame)?;
                        let data = &mut frame[..track.mode.data_bytes()];
                        if track_selected && track.has_subcode {
                            omitted_subcode = true;
                        }
                        track.mode.swap_audio_bytes(data);
                        if let Some(writer) = track_writer.as_mut() {
                            writer.write_all(data)?;
                        }
                    }
                    for _ in 0..track.pad_frames {
                        reader.read_exact(&mut frame)?;
                    }
                    if let Some(writer) = track_writer.as_mut() {
                        writer.flush()?;
                    }
                    physframeofs = physframeofs.saturating_add(track.frames);
                }

                if write_gdi {
                    let mut gdi_writer = BufWriter::new(File::create(&gdi_path)?);
                    produced_outputs.push(gdi_path.clone());
                    gdi_writer.write_all(format!("{}\n", gdi_lines.len()).as_bytes())?;
                    for line in &gdi_lines {
                        gdi_writer.write_all(line.as_bytes())?;
                        gdi_writer.write_all(b"\n")?;
                    }
                    gdi_writer.flush()?;
                }

                Ok((omitted_subcode, produced_outputs))
            })();

            let _ = fs::remove_file(&temp_path);
            let (omitted_subcode, produced_outputs) = build_result?;
            if selection_requested && produced_outputs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "requested selections resolved to no extractable gd outputs".into(),
                ));
            }
            let suffix = if omitted_subcode {
                "; subcode data was omitted from gdi output"
            } else {
                ""
            };

            let label = if selection_requested {
                let outputs = produced_outputs
                    .iter()
                    .map(|path| format!("`{}`", path.display()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "extracted `{}` to selected outputs: {} (gd, {}){}",
                    request.source.display(),
                    outputs,
                    self.header_codec_label(header),
                    suffix
                )
            } else {
                format!(
                    "extracted `{}` to `{}` and per-track gd files (gd, {}){}",
                    request.source.display(),
                    gdi_path.display(),
                    self.header_codec_label(header),
                    suffix
                )
            };

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                label,
                Some(100.0),
                Some(execution),
            ))
        }

    }
