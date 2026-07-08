use super::*;

/// Cook a CD/GD data-frame payload for extraction: audio sectors are byte-swapped (CHD stores
/// audio big-endian); data sectors pass through untouched.
fn cook_disc_frame_payload<'d>(track: &DiscTrack, data: &'d [u8]) -> Cow<'d, [u8]> {
    if track.mode == DiscTrackMode::Audio {
        let mut swapped = data.to_vec();
        track.mode.swap_audio_bytes(&mut swapped);
        Cow::Owned(swapped)
    } else {
        Cow::Borrowed(data)
    }
}

/// Per-frame track router shared by the CD single-bin, CD split-track, and GD-ROM extract loops.
/// A decoded frame stream is each track's data frames followed by its trailing pad frames; the
/// router owns the track cursor and the data/pad accounting, handing every *data* frame's payload
/// slice to `emit(track_index, track, data)` while pad frames only advance the cursor.
struct DiscFrameRouter<'a> {
    tracks: &'a [DiscTrack],
    track_index: usize,
    data_frames_remaining: u32,
    pad_frames_remaining: u32,
    processed_frames: u64,
}

impl<'a> DiscFrameRouter<'a> {
    fn new(tracks: &'a [DiscTrack]) -> Self {
        Self {
            tracks,
            track_index: 0,
            data_frames_remaining: 0,
            pad_frames_remaining: 0,
            processed_frames: 0,
        }
    }

    fn expected_frames(tracks: &[DiscTrack]) -> u64 {
        tracks.iter().fold(0_u64, |total, track| {
            total.saturating_add(u64::from(track.frames))
        })
    }

    fn route_frame<E>(&mut self, frame: &[u8], mut emit: E) -> Result<()>
    where
        E: FnMut(usize, &DiscTrack, &[u8]) -> Result<()>,
    {
        loop {
            if self.track_index >= self.tracks.len() {
                return Ok(());
            }
            if self.data_frames_remaining == 0 && self.pad_frames_remaining == 0 {
                let track = &self.tracks[self.track_index];
                self.data_frames_remaining = track.frames.saturating_sub(track.pad_frames);
                self.pad_frames_remaining = track.pad_frames;
            }
            if self.data_frames_remaining == 0 && self.pad_frames_remaining == 0 {
                self.track_index += 1;
                continue;
            }

            let track = &self.tracks[self.track_index];
            if self.data_frames_remaining > 0 {
                emit(self.track_index, track, &frame[..track.mode.data_bytes()])?;
                self.data_frames_remaining -= 1;
            } else {
                self.pad_frames_remaining -= 1;
            }
            if self.data_frames_remaining == 0 && self.pad_frames_remaining == 0 {
                self.track_index += 1;
            }
            self.processed_frames = self.processed_frames.saturating_add(1);
            break;
        }
        Ok(())
    }

    fn processed_frames(&self) -> u64 {
        self.processed_frames
    }

    fn finished(&self) -> bool {
        self.track_index == self.tracks.len()
    }
}

/// Resolved CD extract plan: which of the cue / single-bin / per-track outputs to
/// write, computed once up front so [`ChdContainerHandler::extract_cd`] reads as a
/// clear sequence of steps. `write_split_tracks` and `split_track_names` are
/// parallel to `layout.tracks` and are only populated when `single_bin` is false.
struct CdSelectionPlan {
    single_bin: bool,
    selection_requested: bool,
    write_cue: bool,
    write_single_bin: bool,
    single_bin_name: String,
    split_track_names: Vec<String>,
    write_split_tracks: Vec<bool>,
}

/// Read-only inputs shared by the CD single-bin and split-track writer paths,
/// grouped so those helpers take a single borrow instead of a long argument list.
struct CdExtractInputs<'a> {
    chd: &'a ChdReadSession,
    layout: &'a DiscLayout,
    request: &'a ContainerExtractRequest,
    context: &'a OperationContext,
    execution: &'a ThreadExecution,
    extract_progress: &'a Arc<dyn Fn(u64) + Send + Sync>,
}

/// Mutable accumulators threaded through the CD writer paths: the shared cue
/// writer plus the outputs/checksums and flags reported back to `extract_cd`.
struct CdExtractSink<'a> {
    cue_writer: &'a mut Option<BufWriter<File>>,
    produced_outputs: &'a mut Vec<PathBuf>,
    output_checksums: &'a mut Vec<ExtractedFileChecksum>,
    omitted_subcode: &'a mut bool,
    wrote_single_bin_output: &'a mut bool,
    cleanup: &'a ChdOutputCleanup,
}

impl ChdContainerHandler {
    /// Resolve a cue sheet into unpadded CD-shaped tracks plus the number of the
    /// first track that falls inside a GD-ROM high-density area (when the sheet
    /// carries `REM HIGH-DENSITY AREA` markers). Callers frame the result as a CD
    /// (with implicit 4-frame padding) or synthesize a GD-ROM layout from it.
    fn resolve_cue_tracks(&self, path: &Path) -> Result<(Vec<DiscTrack>, Option<u32>)> {
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
        // GD-ROM cue sheets mark the inner program area with `REM HIGH-DENSITY
        // AREA`; remember the first track number that follows the marker.
        let mut high_density_first: Option<u32> = None;
        let mut next_track_high_density = false;

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
                "REM" => {
                    if remainder.to_ascii_uppercase().contains("HIGH-DENSITY AREA") {
                        next_track_high_density = true;
                    }
                }
                "TITLE" | "PERFORMER" | "SONGWRITER" | "FLAGS" | "CATALOG" | "ISRC" => {}
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
                    if next_track_high_density {
                        high_density_first.get_or_insert(number);
                        next_track_high_density = false;
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
                        "00" => tracks[track_index].index00_frames = Some(self.parse_msf(time)?),
                        "01" => tracks[track_index].index01_frames = Some(self.parse_msf(time)?),
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
                let candidate_start_frame = candidate.index00_frames.unwrap_or(candidate_index01);
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
                memory_source: None,
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

        Ok((resolved, high_density_first))
    }

    /// Parse a cue sheet as a plain CD-ROM layout (with MAME's implicit 4-frame
    /// track padding applied).
    pub(super) fn parse_cue_file(&self, path: &Path) -> Result<DiscLayout> {
        let (tracks, _high_density_first) = self.resolve_cue_tracks(path)?;
        let mut layout = DiscLayout {
            kind: DiscKind::CdRom,
            tracks,
        };
        layout.apply_cd_track_padding();
        Ok(layout)
    }

    /// Resolve a disc input for the default `chd` format, auto-detecting GD-ROM
    /// media. A `.cue` is treated as a GD-ROM when a sibling `.gdi` exists (its
    /// physical track offsets are authoritative) or when the sheet carries
    /// `REM HIGH-DENSITY AREA` markers; otherwise it is a plain CD-ROM.
    pub(super) fn parse_disc_input(&self, path: &Path) -> Result<DiscLayout> {
        if let Some(gdi_path) = Self::sibling_gdi_path(path) {
            return self.parse_gdi_file(&gdi_path);
        }
        let (tracks, high_density_first) = self.resolve_cue_tracks(path)?;
        match high_density_first {
            Some(first) => self.synthesize_gd_from_cue_tracks(tracks, first),
            None => {
                let mut layout = DiscLayout {
                    kind: DiscKind::CdRom,
                    tracks,
                };
                layout.apply_cd_track_padding();
                Ok(layout)
            }
        }
    }

    /// Return the `.gdi` next to a `.cue` (same stem) when it exists on disk.
    fn sibling_gdi_path(cue_path: &Path) -> Option<PathBuf> {
        if !Self::is_extension(cue_path, "cue") {
            return None;
        }
        let gdi_path = cue_path.with_extension("gdi");
        gdi_path.is_file().then_some(gdi_path)
    }

    /// Build a GD-ROM layout from cue-resolved tracks by anchoring the
    /// high-density area at its standard physical start LBA. Track data stays
    /// contiguous within each density area and the gap between areas becomes
    /// padding frames, mirroring how `parse_gdi_file` frames an explicit `.gdi`.
    fn synthesize_gd_from_cue_tracks(
        &self,
        tracks: Vec<DiscTrack>,
        high_density_first: u32,
    ) -> Result<DiscLayout> {
        let mut phys_ofs = 0_u32;
        let mut phys_starts = Vec::with_capacity(tracks.len());
        for track in &tracks {
            if track.number == high_density_first {
                phys_ofs = Self::GD_HIGH_DENSITY_START_LBA;
            }
            phys_starts.push(phys_ofs);
            phys_ofs = phys_ofs.checked_add(track.frames).ok_or_else(|| {
                RomWeaverError::Validation(
                    "gd-rom track layout exceeds addressable frames".to_string(),
                )
            })?;
        }

        let mut resolved = Vec::with_capacity(tracks.len());
        for (index, track) in tracks.into_iter().enumerate() {
            let phys_start = phys_starts[index];
            let data_frames = track.frames;
            let pad_frames = match phys_starts.get(index + 1) {
                Some(next_start) => next_start
                    .checked_sub(phys_start.saturating_add(data_frames))
                    .ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "gd-rom track {} overlaps the next track",
                            track.number
                        ))
                    })?,
                None => 0,
            };
            resolved.push(DiscTrack {
                frames: data_frames.saturating_add(pad_frames),
                pregap_frames: 0,
                postgap_frames: 0,
                pregap_has_data: false,
                pad_frames,
                ..track
            });
        }

        Ok(DiscLayout {
            kind: DiscKind::GdRom,
            tracks: resolved,
        })
    }

    pub(super) fn parse_gdi_file(&self, path: &Path) -> Result<DiscLayout> {
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
                memory_source: None,
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

    pub(super) fn read_disc_tracks(
        &self,
        chd: &ChdReadSession,
        kind: DiscKind,
    ) -> Result<DiscLayout> {
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
                memory_source: None,
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

        // CD metadata stores the unpadded data frame count; re-derive the
        // implicit 4-frame track padding so extraction skips it (GD-ROM keeps
        // its padding explicitly in the PAD field, so this is a no-op there).
        let mut layout = DiscLayout { kind, tracks };
        layout.apply_cd_track_padding();
        Ok(layout)
    }

    pub(super) fn track_output_name(&self, stem: &str, track_number: u32) -> String {
        format!("{stem} (Track {track_number}).bin")
    }

    pub(super) fn stream_chd_frames_with_progress<F>(
        &self,
        chd: &ChdReadSession,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
        mut on_frame: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()>,
    {
        let frame_len = Self::CD_FRAME_BYTES as usize;
        let mut frame = vec![0_u8; frame_len];
        let mut filled = 0_usize;
        chd.stream_with_progress(thread_count, on_progress, |chunk| {
            let mut offset = 0_usize;
            while offset < chunk.len() {
                if filled == 0 {
                    let full_frame_bytes = ((chunk.len() - offset) / frame_len) * frame_len;
                    let full_frame_end = offset + full_frame_bytes;
                    while offset < full_frame_end {
                        on_frame(&chunk[offset..offset + frame_len])?;
                        offset += frame_len;
                    }
                    if offset == chunk.len() {
                        break;
                    }
                }
                let copy_len = (frame_len - filled).min(chunk.len() - offset);
                frame[filled..filled + copy_len].copy_from_slice(&chunk[offset..offset + copy_len]);
                filled += copy_len;
                offset += copy_len;
                if filled == frame_len {
                    on_frame(&frame)?;
                    filled = 0;
                }
            }
            Ok(())
        })?;
        if filled != 0 {
            return Err(RomWeaverError::Validation(
                "cd/gd chd payload ended with a partial frame".to_string(),
            ));
        }
        Ok(())
    }

    pub(super) fn extract_cd(
        &self,
        chd: ChdReadSession,
        request: &ContainerExtractRequest,
        context: &OperationContext,
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
        debug!(
            tracks = layout.tracks.len(),
            media = ?chd.media_kind(),
            expected_frames = DiscFrameRouter::expected_frames(&layout.tracks),
            logical_bytes = header.logical_bytes,
            threads = execution.effective_threads,
            "chd extract cd start"
        );
        fs::create_dir_all(&request.out_dir)?;
        let stem = request
            .source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        let cue_path = request.out_dir.join(format!("{stem}.cue"));
        let extract_progress = self.progress_bytes_callback(
            context,
            &execution,
            "extract",
            "extract",
            header.logical_bytes,
            format!("extracting `{}`", CHD.name),
        );
        let plan = self.plan_cd_selection(&layout, request, stem)?;
        let selection_requested = plan.selection_requested;

        // Each writer registers its output with `cleanup` only after the file is
        // actually created, so a mid-decode error removes the partial
        // `.cue`/`.bin` files this op created without ever deleting a pre-existing
        // target a `--no-overwrite` refusal left untouched.
        let cleanup = ChdOutputCleanup::new();

        let inputs = CdExtractInputs {
            chd: &chd,
            layout: &layout,
            request,
            context,
            execution: &execution,
            extract_progress: &extract_progress,
        };
        let (omitted_subcode, produced_outputs, wrote_single_bin_output, output_checksums) =
            self.build_cd_extract_result(&inputs, &plan, &cue_path, &cleanup)?;
        if request.kind_filter.enabled() && produced_outputs.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "no extract entries from `{}` matched {}",
                request.source.display(),
                request.kind_filter.flag_label()
            )));
        }
        if selection_requested && produced_outputs.is_empty() {
            return Err(RomWeaverError::Validation(
                "requested selections resolved to no extractable cd outputs".into(),
            ));
        }
        cleanup.commit();
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
            let bin_path = request.out_dir.join(&plan.single_bin_name);
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

        let file_count = produced_outputs.len();
        let written_bytes = produced_outputs
            .iter()
            .filter_map(|path| fs::metadata(path).ok().map(|metadata| metadata.len()))
            .sum::<u64>();
        debug!(
            files = file_count,
            written_bytes, omitted_subcode, "chd extract cd done"
        );
        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(CHD.name.to_string()),
            "extract",
            label,
            Some(100.0),
            Some(execution.clone()),
        );
        let report =
            attach_extraction_details(report, file_count, file_count, written_bytes, &execution);
        let report = attach_extract_checksum_details(report, output_checksums);
        Ok(attach_emitted_file_paths(report, &produced_outputs))
    }

    /// Resolve which CD outputs to write (cue, single combined bin, or per-track
    /// bins) from the request's split-bin flag, explicit selections, and
    /// kind-filter. A layout whose tracks all share one data-byte size extracts as
    /// a single bin unless split-bin was requested; otherwise it splits per track.
    /// When the cue alone was selected, the matching payload outputs are re-enabled
    /// so the cue does not reference files that were never written.
    fn plan_cd_selection(
        &self,
        layout: &DiscLayout,
        request: &ContainerExtractRequest,
        stem: &str,
    ) -> Result<CdSelectionPlan> {
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
        let cue_selected = selections.matches(&cue_name);
        let write_cue = cue_selected && request.kind_filter.matches_payload_name(&cue_name);
        let single_bin_name = format!("{stem}.bin");
        let mut write_single_bin = single_bin
            && selections.matches(&single_bin_name)
            && request.kind_filter.matches_payload_name(&single_bin_name);
        let mut split_track_names = Vec::new();
        let mut write_split_tracks = Vec::new();
        if !single_bin {
            for track in &layout.tracks {
                let track_name = self.track_output_name(stem, track.number);
                let track_selected = selections.matches(&track_name);
                write_split_tracks
                    .push(track_selected && request.kind_filter.matches_payload_name(&track_name));
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
                    write_single_bin = request.kind_filter.matches_payload_name(&single_bin_name);
                } else {
                    for (selected, track_name) in
                        write_split_tracks.iter_mut().zip(split_track_names.iter())
                    {
                        *selected = request.kind_filter.matches_payload_name(track_name);
                    }
                }
            }
        }
        selections.ensure_all_matched()?;

        Ok(CdSelectionPlan {
            single_bin,
            selection_requested,
            write_cue,
            write_single_bin,
            single_bin_name,
            split_track_names,
            write_split_tracks,
        })
    }

    /// Write the planned CD outputs: open the cue writer (when selected), dispatch
    /// to the single-bin or split-track writer, then flush the cue. Returns
    /// `(omitted_subcode, produced_outputs, wrote_single_bin_output,
    /// output_checksums)` in the same order the inline closure did.
    fn build_cd_extract_result(
        &self,
        inputs: &CdExtractInputs<'_>,
        plan: &CdSelectionPlan,
        cue_path: &Path,
        cleanup: &ChdOutputCleanup,
    ) -> Result<(bool, Vec<PathBuf>, bool, Vec<ExtractedFileChecksum>)> {
        let mut omitted_subcode = false;
        let mut produced_outputs = Vec::new();
        let mut output_checksums = Vec::new();
        let mut cue_writer = if plan.write_cue {
            let writer = cleanup.create_output(cue_path, inputs.request.overwrite)?;
            produced_outputs.push(cue_path.to_path_buf());
            Some(BufWriter::new(writer))
        } else {
            None
        };
        let mut wrote_single_bin_output = false;

        let mut sink = CdExtractSink {
            cue_writer: &mut cue_writer,
            produced_outputs: &mut produced_outputs,
            output_checksums: &mut output_checksums,
            omitted_subcode: &mut omitted_subcode,
            wrote_single_bin_output: &mut wrote_single_bin_output,
            cleanup,
        };
        if plan.single_bin {
            self.write_cd_single_bin(inputs, plan, &mut sink)?;
        } else {
            self.write_cd_split_tracks(inputs, plan, &mut sink)?;
        }

        if let Some(writer) = cue_writer.as_mut() {
            writer.flush()?;
        }
        Ok((
            omitted_subcode,
            produced_outputs,
            wrote_single_bin_output,
            output_checksums,
        ))
    }

    /// Single combined-bin CD path: emit the cue body (with running output-frame
    /// MSF offsets), stream every track's cooked frames into one `.bin`, and
    /// finalize its checksum. Sets `omitted_subcode` when subcode is dropped and
    /// `wrote_single_bin_output` when the bin is actually written.
    fn write_cd_single_bin(
        &self,
        inputs: &CdExtractInputs<'_>,
        plan: &CdSelectionPlan,
        sink: &mut CdExtractSink<'_>,
    ) -> Result<()> {
        let CdExtractInputs {
            chd,
            layout,
            request,
            context,
            execution,
            extract_progress,
        } = *inputs;
        let single_bin_name = &plan.single_bin_name;
        let write_single_bin = plan.write_single_bin;
        let bin_path = request.out_dir.join(single_bin_name);
        let mut bin_writer = if write_single_bin {
            let writer = sink.cleanup.create_output(&bin_path, request.overwrite)?;
            *sink.wrote_single_bin_output = true;
            sink.produced_outputs.push(bin_path.clone());
            Some(BufWriter::new(writer))
        } else {
            None
        };
        let mut single_bin_checksum = if write_single_bin {
            create_extract_checksum(context)?
        } else {
            None
        };
        let cue_writer = &mut *sink.cue_writer;
        if let Some(writer) = cue_writer.as_mut() {
            writer.write_all(format!("FILE \"{single_bin_name}\" BINARY\n").as_bytes())?;
        }
        let mut output_frame_offset = 0_u32;
        for track in &layout.tracks {
            if let Some(writer) = cue_writer.as_mut() {
                writer.write_all(
                    format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label()).as_bytes(),
                )?;
                if track.pregap_frames > 0 && track.pregap_has_data {
                    writer.write_all(
                        format!("    INDEX 00 {}\n", self.format_msf(output_frame_offset))
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
                        format!("    PREGAP {}\n", self.format_msf(track.pregap_frames)).as_bytes(),
                    )?;
                    writer.write_all(
                        format!("    INDEX 01 {}\n", self.format_msf(output_frame_offset))
                            .as_bytes(),
                    )?;
                } else {
                    writer.write_all(
                        format!("    INDEX 01 {}\n", self.format_msf(output_frame_offset))
                            .as_bytes(),
                    )?;
                }
                if track.postgap_frames > 0 {
                    writer.write_all(
                        format!("    POSTGAP {}\n", self.format_msf(track.postgap_frames))
                            .as_bytes(),
                    )?;
                }
            }
            output_frame_offset =
                output_frame_offset.saturating_add(track.frames.saturating_sub(track.pad_frames));
        }

        let expected_frames = DiscFrameRouter::expected_frames(&layout.tracks);
        let mut router = DiscFrameRouter::new(&layout.tracks);
        let omitted_subcode = &mut *sink.omitted_subcode;
        self.stream_chd_frames_with_progress(
            chd,
            execution.effective_threads,
            Some(extract_progress),
            |frame| {
                router.route_frame(frame, |_track_index, track, data| {
                    if write_single_bin && track.has_subcode {
                        *omitted_subcode = true;
                    }
                    if let Some(writer) = bin_writer.as_mut() {
                        let data = cook_disc_frame_payload(track, data);
                        writer.write_all(data.as_ref())?;
                        if let Some(checksum) = single_bin_checksum.as_mut() {
                            checksum.update(data.as_ref())?;
                        }
                    }
                    Ok(())
                })
            },
        )?;
        if router.processed_frames() != expected_frames || !router.finished() {
            return Err(RomWeaverError::Validation(
                "cd chd ended before all track frames were decoded".to_string(),
            ));
        }
        if let Some(writer) = bin_writer.as_mut() {
            writer.flush()?;
        }
        push_finalized_extract_checksum(
            sink.output_checksums,
            bin_path,
            single_bin_checksum.take(),
        )?;
        Ok(())
    }

    /// Per-track CD path: emit one cue FILE entry per selected track, stream each
    /// selected track's cooked frames into its own `.bin`, flush, and finalize the
    /// per-track checksums. Sets `omitted_subcode` when subcode is dropped.
    fn write_cd_split_tracks(
        &self,
        inputs: &CdExtractInputs<'_>,
        plan: &CdSelectionPlan,
        sink: &mut CdExtractSink<'_>,
    ) -> Result<()> {
        let CdExtractInputs {
            chd,
            layout,
            request,
            context,
            execution,
            extract_progress,
        } = *inputs;
        let split_track_names = &plan.split_track_names;
        let write_split_tracks = &plan.write_split_tracks;
        let cue_writer = &mut *sink.cue_writer;
        for (track_index, track) in layout.tracks.iter().enumerate() {
            let track_name = &split_track_names[track_index];
            let track_selected = write_split_tracks[track_index];
            if track_selected && let Some(writer) = cue_writer.as_mut() {
                writer.write_all(format!("FILE \"{track_name}\" BINARY\n").as_bytes())?;
                writer.write_all(
                    format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label()).as_bytes(),
                )?;
                if track.pregap_frames > 0 && track.pregap_has_data {
                    writer.write_all(b"    INDEX 00 00:00:00\n")?;
                    writer.write_all(
                        format!("    INDEX 01 {}\n", self.format_msf(track.pregap_frames))
                            .as_bytes(),
                    )?;
                } else if track.pregap_frames > 0 {
                    writer.write_all(
                        format!("    PREGAP {}\n", self.format_msf(track.pregap_frames)).as_bytes(),
                    )?;
                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                } else {
                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                }
                if track.postgap_frames > 0 {
                    writer.write_all(
                        format!("    POSTGAP {}\n", self.format_msf(track.postgap_frames))
                            .as_bytes(),
                    )?;
                }
            }
        }

        let mut track_writers = Vec::with_capacity(layout.tracks.len());
        let mut track_checksums = Vec::with_capacity(layout.tracks.len());
        for (track_index, track_name) in split_track_names.iter().enumerate() {
            if write_split_tracks[track_index] {
                let track_path = request.out_dir.join(track_name);
                let writer = sink.cleanup.create_output(&track_path, request.overwrite)?;
                sink.produced_outputs.push(track_path.clone());
                track_writers.push(Some(BufWriter::new(writer)));
                track_checksums.push(create_extract_checksum(context)?);
            } else {
                track_writers.push(None);
                track_checksums.push(None);
            }
        }

        let expected_frames = DiscFrameRouter::expected_frames(&layout.tracks);
        let mut router = DiscFrameRouter::new(&layout.tracks);
        let omitted_subcode = &mut *sink.omitted_subcode;
        self.stream_chd_frames_with_progress(
            chd,
            execution.effective_threads,
            Some(extract_progress),
            |frame| {
                router.route_frame(frame, |track_index, track, data| {
                    if write_split_tracks[track_index] {
                        if track.has_subcode {
                            *omitted_subcode = true;
                        }
                        let data = cook_disc_frame_payload(track, data);
                        if let Some(writer) = track_writers[track_index].as_mut() {
                            writer.write_all(data.as_ref())?;
                            if let Some(checksum) = track_checksums[track_index].as_mut() {
                                checksum.update(data.as_ref())?;
                            }
                        }
                    }
                    Ok(())
                })
            },
        )?;
        if router.processed_frames() != expected_frames || !router.finished() {
            return Err(RomWeaverError::Validation(
                "cd chd ended before all track frames were decoded".to_string(),
            ));
        }
        for writer in &mut track_writers {
            if let Some(writer) = writer.as_mut() {
                writer.flush()?;
            }
        }
        for (track_index, checksum) in track_checksums.iter_mut().enumerate() {
            if !write_split_tracks[track_index] {
                continue;
            }
            let track_path = request.out_dir.join(&split_track_names[track_index]);
            push_finalized_extract_checksum(sink.output_checksums, track_path, checksum.take())?;
        }
        Ok(())
    }

    pub(super) fn extract_gd(
        &self,
        chd: ChdReadSession,
        request: &ContainerExtractRequest,
        context: &OperationContext,
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
        debug!(
            tracks = layout.tracks.len(),
            media = ?chd.media_kind(),
            expected_frames = DiscFrameRouter::expected_frames(&layout.tracks),
            logical_bytes = header.logical_bytes,
            threads = execution.effective_threads,
            "chd extract gd start"
        );
        fs::create_dir_all(&request.out_dir)?;
        let stem = request
            .source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        let gdi_path = request.out_dir.join(format!("{stem}.gdi"));
        let extract_progress = self.progress_bytes_callback(
            context,
            &execution,
            "extract",
            "extract",
            header.logical_bytes,
            format!("extracting `{}`", CHD.name),
        );

        let selection_requested = !request.selections.is_empty();
        let gdi_name = format!("{stem}.gdi");
        let mut selections = SelectionMatcher::new(&request.selections);
        let gdi_selected = selections.matches(&gdi_name);
        let write_gdi = gdi_selected && request.kind_filter.matches_payload_name(&gdi_name);
        let mut track_names = Vec::with_capacity(layout.tracks.len());
        let mut write_tracks = Vec::with_capacity(layout.tracks.len());
        for track in &layout.tracks {
            let track_name = self.track_output_name(stem, track.number);
            let track_selected = selections.matches(&track_name);
            write_tracks
                .push(track_selected && request.kind_filter.matches_payload_name(&track_name));
            track_names.push(track_name);
        }
        if selection_requested && write_gdi && !write_tracks.iter().any(|selected| *selected) {
            for (selected, track_name) in write_tracks.iter_mut().zip(track_names.iter()) {
                *selected = request.kind_filter.matches_payload_name(track_name);
            }
        }
        selections.ensure_all_matched()?;

        // Each track/gdi writer registers its output with `cleanup` only after
        // the file is created, so a mid-decode error removes the partial files
        // this op created without ever deleting a pre-existing target a
        // `--no-overwrite` refusal left untouched.
        let cleanup = ChdOutputCleanup::new();

        let build_result: Result<(bool, Vec<PathBuf>, Vec<ExtractedFileChecksum>)> = (|| {
            let mut omitted_subcode = false;
            let mut produced_outputs = Vec::new();
            let mut output_checksums = Vec::new();
            let mut gdi_lines = Vec::new();
            let mut physframeofs = 0_u32;

            for (track_index, track) in layout.tracks.iter().enumerate() {
                let (track_type, sector_size) = track.mode.gdi_track_descriptor()?;
                let track_name = &track_names[track_index];
                let track_selected = write_tracks[track_index];
                if track_selected {
                    gdi_lines.push(format!(
                        "{} {} {} {} \"{}\" 0",
                        track.number, physframeofs, track_type, sector_size, track_name
                    ));
                }
                physframeofs = physframeofs.saturating_add(track.frames);
            }

            let mut track_writers = Vec::with_capacity(layout.tracks.len());
            let mut track_checksums = Vec::with_capacity(layout.tracks.len());
            for (track_index, track_name) in track_names.iter().enumerate() {
                if write_tracks[track_index] {
                    let track_path = request.out_dir.join(track_name);
                    let writer = cleanup.create_output(&track_path, request.overwrite)?;
                    produced_outputs.push(track_path.clone());
                    track_writers.push(Some(BufWriter::new(writer)));
                    track_checksums.push(create_extract_checksum(context)?);
                } else {
                    track_writers.push(None);
                    track_checksums.push(None);
                }
            }

            let expected_frames = DiscFrameRouter::expected_frames(&layout.tracks);
            let mut router = DiscFrameRouter::new(&layout.tracks);
            self.stream_chd_frames_with_progress(
                &chd,
                execution.effective_threads,
                Some(&extract_progress),
                |frame| {
                    router.route_frame(frame, |track_index, track, data| {
                        if write_tracks[track_index] {
                            if track.has_subcode {
                                omitted_subcode = true;
                            }
                            let data = cook_disc_frame_payload(track, data);
                            if let Some(writer) = track_writers[track_index].as_mut() {
                                writer.write_all(data.as_ref())?;
                                if let Some(checksum) = track_checksums[track_index].as_mut() {
                                    checksum.update(data.as_ref())?;
                                }
                            }
                        }
                        Ok(())
                    })
                },
            )?;
            if router.processed_frames() != expected_frames || !router.finished() {
                return Err(RomWeaverError::Validation(
                    "gd chd ended before all track frames were decoded".to_string(),
                ));
            }
            for writer in &mut track_writers {
                if let Some(writer) = writer.as_mut() {
                    writer.flush()?;
                }
            }
            for (track_index, checksum) in track_checksums.iter_mut().enumerate() {
                if !write_tracks[track_index] {
                    continue;
                }
                let track_path = request.out_dir.join(&track_names[track_index]);
                push_finalized_extract_checksum(
                    &mut output_checksums,
                    track_path,
                    checksum.take(),
                )?;
            }

            if write_gdi {
                let mut gdi_writer =
                    BufWriter::new(cleanup.create_output(&gdi_path, request.overwrite)?);
                produced_outputs.push(gdi_path.clone());
                gdi_writer.write_all(format!("{}\n", gdi_lines.len()).as_bytes())?;
                for line in &gdi_lines {
                    gdi_writer.write_all(line.as_bytes())?;
                    gdi_writer.write_all(b"\n")?;
                }
                gdi_writer.flush()?;
            }

            Ok((omitted_subcode, produced_outputs, output_checksums))
        })();

        let (omitted_subcode, produced_outputs, output_checksums) = build_result?;
        if request.kind_filter.enabled() && produced_outputs.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "no extract entries from `{}` matched {}",
                request.source.display(),
                request.kind_filter.flag_label()
            )));
        }
        if selection_requested && produced_outputs.is_empty() {
            return Err(RomWeaverError::Validation(
                "requested selections resolved to no extractable gd outputs".into(),
            ));
        }
        cleanup.commit();
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

        let file_count = produced_outputs.len();
        let written_bytes = produced_outputs
            .iter()
            .filter_map(|path| fs::metadata(path).ok().map(|metadata| metadata.len()))
            .sum::<u64>();
        debug!(
            files = file_count,
            written_bytes, omitted_subcode, "chd extract gd done"
        );
        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(CHD.name.to_string()),
            "extract",
            label,
            Some(100.0),
            Some(execution.clone()),
        );
        let report =
            attach_extraction_details(report, file_count, file_count, written_bytes, &execution);
        let report = attach_extract_checksum_details(report, output_checksums);
        Ok(attach_emitted_file_paths(report, &produced_outputs))
    }
}
