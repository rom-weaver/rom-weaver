use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use rom_weaver_chd_sys::{
    CD_FRAME_SIZE, CDROM_TRACK_METADATA2_TAG, CHD_MAX_COMPRESSORS, CHD_METADATA_FLAG_CHECKSUM,
    ChdCodec, ChdFile, ChdMediaKind, CreateOptions, DVD_METADATA_TAG, GDROM_TRACK_METADATA_TAG,
    HARD_DISK_METADATA_TAG, build_info,
};
use rom_weaver_core::{
    ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest, ContainerHandler,
    ContainerInspectRequest, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    ProbeConfidence, Result, RomWeaverError, ThreadCapability,
};

const ZIP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zip",
    aliases: &[],
    extensions: &[".zip"],
};
const ZIPX: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zipx",
    aliases: &[],
    extensions: &[".zipx"],
};
const SEVEN_Z: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "7z",
    aliases: &["7zip"],
    extensions: &[".7z"],
};
const TAR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar",
    aliases: &[],
    extensions: &[".tar"],
};
const TAR_GZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.gz",
    aliases: &["tgz"],
    extensions: &[".tar.gz", ".tgz"],
};
const TAR_BZ2: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.bz2",
    aliases: &["tbz2"],
    extensions: &[".tar.bz2", ".tbz2"],
};
const TAR_XZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.xz",
    aliases: &["txz"],
    extensions: &[".tar.xz", ".txz"],
};
const CHD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "chd",
    aliases: &[],
    extensions: &[".chd"],
};
const RVZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "rvz",
    aliases: &[],
    extensions: &[".rvz"],
};
const Z3DS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "z3ds",
    aliases: &["3ds"],
    extensions: &[".z3ds", ".3ds"],
};

pub struct ContainerRegistry {
    handlers: Vec<Arc<dyn ContainerHandler>>,
}

impl Default for ContainerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ContainerRegistry {
    pub fn new() -> Self {
        Self {
            handlers: vec![
                Arc::new(StaticContainerHandler::new(&ZIP)),
                Arc::new(StaticContainerHandler::new(&ZIPX)),
                Arc::new(StaticContainerHandler::new(&SEVEN_Z)),
                Arc::new(StaticContainerHandler::new(&TAR)),
                Arc::new(StaticContainerHandler::new(&TAR_GZ)),
                Arc::new(StaticContainerHandler::new(&TAR_BZ2)),
                Arc::new(StaticContainerHandler::new(&TAR_XZ)),
                Arc::new(ChdContainerHandler),
                Arc::new(StaticContainerHandler::new(&RVZ)),
                Arc::new(StaticContainerHandler::new(&Z3DS)),
            ],
        }
    }

    pub fn handlers(&self) -> &[Arc<dyn ContainerHandler>] {
        &self.handlers
    }

    pub fn probe(&self, path: &Path) -> Option<Arc<dyn ContainerHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_path(path))
            .cloned()
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn ContainerHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_name(name))
            .cloned()
    }
}

struct StaticContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl StaticContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn unsupported_label(&self, operation: &str) -> String {
        format!(
            "{operation} is not implemented yet for {}",
            self.descriptor.name
        )
    }
}

impl ContainerHandler for StaticContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _source: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        _request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(OperationReport::unsupported(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            self.unsupported_label("inspect"),
            None,
        ))
    }

    fn extract(
        &self,
        _request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            self.unsupported_label("extract"),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            self.unsupported_label("create"),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: false,
            extract: false,
            create: false,
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

struct ChdContainerHandler;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HdGeometry {
    cylinders: u32,
    heads: u32,
    sectors: u32,
    bytes_per_sector: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiscLayout {
    kind: DiscKind,
    tracks: Vec<DiscTrack>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiscTrack {
    number: u32,
    mode: DiscTrackMode,
    file_path: PathBuf,
    file_offset_bytes: u64,
    frames: u32,
    pregap_frames: u32,
    postgap_frames: u32,
    pregap_has_data: bool,
    has_subcode: bool,
    pad_frames: u32,
    swap_audio_on_read: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiscKind {
    CdRom,
    GdRom,
}

impl DiscKind {
    fn metadata_tag(self) -> u32 {
        match self {
            Self::CdRom => CDROM_TRACK_METADATA2_TAG,
            Self::GdRom => GDROM_TRACK_METADATA_TAG,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiscTrackMode {
    Mode1,
    Mode1Raw,
    Mode2,
    Mode2Form1,
    Mode2Form2,
    Mode2FormMix,
    Mode2Raw,
    Audio,
}

impl DiscTrackMode {
    fn cue_label(self) -> &'static str {
        match self {
            Self::Mode1 => "MODE1/2048",
            Self::Mode1Raw => "MODE1/2352",
            Self::Mode2 => "MODE2/2336",
            Self::Mode2Form1 => "MODE2/2048",
            Self::Mode2Form2 => "MODE2/2324",
            Self::Mode2FormMix => "MODE2_FORM_MIX",
            Self::Mode2Raw => "MODE2/2352",
            Self::Audio => "AUDIO",
        }
    }

    fn metadata_label(self) -> &'static str {
        match self {
            Self::Mode1 => "MODE1",
            Self::Mode1Raw => "MODE1_RAW",
            Self::Mode2 => "MODE2",
            Self::Mode2Form1 => "MODE2_FORM1",
            Self::Mode2Form2 => "MODE2_FORM2",
            Self::Mode2FormMix => "MODE2_FORM_MIX",
            Self::Mode2Raw => "MODE2_RAW",
            Self::Audio => "AUDIO",
        }
    }

    fn data_bytes(self) -> usize {
        match self {
            Self::Mode1 | Self::Mode2Form1 => 2048,
            Self::Mode2 | Self::Mode2FormMix => 2336,
            Self::Mode2Form2 => 2324,
            Self::Mode1Raw | Self::Mode2Raw | Self::Audio => 2352,
        }
    }

    fn gdi_track_descriptor(self) -> Result<(u32, u32)> {
        match self {
            Self::Mode1Raw => Ok((4, 2352)),
            Self::Mode1 => Ok((4, 2048)),
            Self::Audio => Ok((0, 2352)),
            other => Err(RomWeaverError::Validation(format!(
                "gd-rom output does not support {} tracks",
                other.metadata_label()
            ))),
        }
    }

    fn swap_audio_bytes(self, buffer: &mut [u8]) {
        if !matches!(self, Self::Audio) {
            return;
        }
        for pair in buffer.chunks_exact_mut(2) {
            pair.swap(0, 1);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ChdCreateKind {
    Raw,
    HardDisk(HdGeometry),
    Dvd,
    Disc(DiscLayout),
}

fn split_token(text: &str) -> Option<(&str, &str)> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('"') {
        let end = rest.find('"')?;
        let token = &rest[..end];
        let remainder = &rest[end + 1..];
        Some((token, remainder))
    } else {
        let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        Some((&trimmed[..end], &trimmed[end..]))
    }
}

impl ChdContainerHandler {
    const DEFAULT_HUNK_BYTES: u32 = 4096;
    const DVD_SECTOR_BYTES: u32 = 2048;
    const HD_SECTOR_BYTES: u32 = 512;
    const CD_FRAME_BYTES: u32 = CD_FRAME_SIZE;
    const CD_HUNK_BYTES: u32 = CD_FRAME_SIZE * 8;

    fn ensure_backend(&self) -> Result<()> {
        let info = build_info();
        if info.backend_available {
            Ok(())
        } else {
            Err(RomWeaverError::Unsupported(format!(
                "chd backend unavailable: {}",
                info.backend_name
            )))
        }
    }

    fn media_label(&self, media_kind: ChdMediaKind) -> &'static str {
        match media_kind {
            ChdMediaKind::Raw => "raw",
            ChdMediaKind::HardDisk => "hd",
            ChdMediaKind::CdRom => "cd",
            ChdMediaKind::GdRom => "gd",
            ChdMediaKind::Dvd => "dvd",
            ChdMediaKind::Av => "av",
        }
    }

    fn resolve_codec(&self, codec: Option<&str>, _create_kind: &ChdCreateKind) -> Result<ChdCodec> {
        self.map_codec(codec)
    }

    fn map_codec(&self, codec: Option<&str>) -> Result<ChdCodec> {
        match codec.map(|value| value.trim().to_ascii_lowercase()) {
            None => Ok(ChdCodec::ZSTD),
            Some(name) if matches!(name.as_str(), "store" | "none" | "uncompressed") => {
                Ok(ChdCodec::NONE)
            }
            Some(name) if matches!(name.as_str(), "deflate" | "zlib") => Ok(ChdCodec::ZLIB),
            Some(name) if name == "zstd" => Ok(ChdCodec::ZSTD),
            Some(name) if matches!(name.as_str(), "lzma" | "lzma2" | "xz") => Ok(ChdCodec::LZMA),
            Some(name) if matches!(name.as_str(), "huffman" | "huff") => Ok(ChdCodec::HUFFMAN),
            Some(name) => Err(RomWeaverError::Validation(format!(
                "unsupported chd codec `{name}`; supported codecs are store, zlib, zstd, lzma, and huffman"
            ))),
        }
    }

    fn codec_label(&self, codec: ChdCodec) -> &'static str {
        match codec {
            ChdCodec::NONE => "store",
            ChdCodec::ZLIB => "zlib",
            ChdCodec::ZSTD => "zstd",
            ChdCodec::LZMA => "lzma",
            ChdCodec::HUFFMAN => "huffman",
            _ => "unknown",
        }
    }

    fn header_codec_label(&self, header: rom_weaver_chd_sys::ChdHeader) -> String {
        let codecs = header
            .compression
            .into_iter()
            .filter(|codec| *codec != ChdCodec::NONE)
            .map(|codec| self.codec_label(codec))
            .collect::<Vec<_>>();
        if codecs.is_empty() {
            "store".to_string()
        } else {
            codecs.join("+")
        }
    }

    fn extract_extension(&self, media_kind: ChdMediaKind) -> Result<&'static str> {
        match media_kind {
            ChdMediaKind::Raw => Ok(".bin"),
            ChdMediaKind::HardDisk => Ok(".img"),
            ChdMediaKind::Dvd => Ok(".iso"),
            ChdMediaKind::CdRom => Ok(".cue"),
            ChdMediaKind::GdRom => Ok(".gdi"),
            ChdMediaKind::Av => Err(RomWeaverError::Validation(
                "chd extract does not support av images yet; current extract supports raw payloads, hd images, and dvd images".into(),
            )),
        }
    }

    fn extract_name(&self, source: &Path, media_kind: ChdMediaKind) -> Result<String> {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        Ok(format!("{stem}{}", self.extract_extension(media_kind)?))
    }

    fn parse_disc_mode(&self, value: &str) -> Result<DiscTrackMode> {
        match value.trim().to_ascii_uppercase().as_str() {
            "MODE1" | "MODE1/2048" => Ok(DiscTrackMode::Mode1),
            "MODE1/2352" | "MODE1_RAW" => Ok(DiscTrackMode::Mode1Raw),
            "MODE2" | "MODE2/2336" => Ok(DiscTrackMode::Mode2),
            "MODE2_FORM1" | "MODE2/2048" => Ok(DiscTrackMode::Mode2Form1),
            "MODE2_FORM2" | "MODE2/2324" => Ok(DiscTrackMode::Mode2Form2),
            "MODE2_FORM_MIX" => Ok(DiscTrackMode::Mode2FormMix),
            "MODE2/2352" | "MODE2_RAW" | "CDI/2352" => Ok(DiscTrackMode::Mode2Raw),
            "AUDIO" => Ok(DiscTrackMode::Audio),
            other => Err(RomWeaverError::Validation(format!(
                "unsupported disc track type `{other}`; supported types are MODE1/2048, MODE1/2352, MODE2/2336, MODE2/2048, MODE2/2324, MODE2_FORM_MIX, MODE2/2352, and AUDIO"
            ))),
        }
    }

    fn parse_msf(&self, value: &str) -> Result<u32> {
        let mut parts = value.split(':');
        let minutes = parts
            .next()
            .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
            .parse::<u32>()
            .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
        let seconds = parts
            .next()
            .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
            .parse::<u32>()
            .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
        let frames = parts
            .next()
            .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
            .parse::<u32>()
            .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
        if parts.next().is_some() || seconds >= 60 || frames >= 75 {
            return Err(RomWeaverError::Validation(format!(
                "invalid cue time `{value}`"
            )));
        }
        Ok(minutes * 60 * 75 + seconds * 75 + frames)
    }

    fn format_msf(&self, frames: u32) -> String {
        let minutes = frames / (60 * 75);
        let seconds = (frames / 75) % 60;
        let frame = frames % 75;
        format!("{minutes:02}:{seconds:02}:{frame:02}")
    }

    fn parse_wave_file(&self, path: &Path) -> Result<(u64, u64)> {
        let mut reader = BufReader::new(File::open(path)?);
        let mut header = [0_u8; 12];
        reader.read_exact(&mut header)?;
        if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` is not a RIFF/WAVE file",
                path.display()
            )));
        }

        let mut audio_format = None;
        let mut channels = None;
        let mut sample_rate = None;
        let mut block_align = None;
        let mut bits_per_sample = None;
        let mut data = None;

        loop {
            let mut chunk_header = [0_u8; 8];
            match reader.read_exact(&mut chunk_header) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            }

            let chunk_size = u64::from(u32::from_le_bytes([
                chunk_header[4],
                chunk_header[5],
                chunk_header[6],
                chunk_header[7],
            ]));
            let chunk_data_offset = reader.stream_position()?;
            let padded_size = chunk_size + (chunk_size % 2);

            match &chunk_header[..4] {
                b"fmt " => {
                    let chunk_len = usize::try_from(chunk_size).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "wave track `{}` has an oversized fmt chunk",
                            path.display()
                        ))
                    })?;
                    let mut chunk = vec![0_u8; chunk_len];
                    reader.read_exact(&mut chunk)?;
                    if chunk.len() < 16 {
                        return Err(RomWeaverError::Validation(format!(
                            "wave track `{}` has a truncated fmt chunk",
                            path.display()
                        )));
                    }
                    audio_format = Some(u16::from_le_bytes([chunk[0], chunk[1]]));
                    channels = Some(u16::from_le_bytes([chunk[2], chunk[3]]));
                    sample_rate =
                        Some(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
                    block_align = Some(u16::from_le_bytes([chunk[12], chunk[13]]));
                    bits_per_sample = Some(u16::from_le_bytes([chunk[14], chunk[15]]));
                    if padded_size != chunk_size {
                        reader.seek(SeekFrom::Current(1))?;
                    }
                }
                b"data" => {
                    data = Some((chunk_data_offset, chunk_size));
                    let skip = i64::try_from(padded_size).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "wave track `{}` is too large for current parsing support",
                            path.display()
                        ))
                    })?;
                    reader.seek(SeekFrom::Current(skip))?;
                }
                _ => {
                    let skip = i64::try_from(padded_size).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "wave track `{}` is too large for current parsing support",
                            path.display()
                        ))
                    })?;
                    reader.seek(SeekFrom::Current(skip))?;
                }
            }
        }

        let audio_format = audio_format.ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "wave track `{}` is missing a fmt chunk",
                path.display()
            ))
        })?;
        if audio_format != 1 {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` uses unsupported format code {}; only PCM WAVE tracks are supported",
                path.display(),
                audio_format
            )));
        }
        if channels != Some(2)
            || sample_rate != Some(44_100)
            || block_align != Some(4)
            || bits_per_sample != Some(16)
        {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` must be 44.1 kHz 16-bit stereo PCM for chd audio tracks",
                path.display()
            )));
        }

        let (data_offset, data_len) = data.ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "wave track `{}` is missing a data chunk",
                path.display()
            ))
        })?;
        if data_len % 2352 != 0 {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` data length is not divisible by 2352 bytes",
                path.display()
            )));
        }
        Ok((data_offset, data_len))
    }

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
        let text = fs::read_to_string(path)?;
        let mut tracks = Vec::<PendingTrack>::new();
        let mut current_file: Option<PendingFile> = None;
        let mut current_track: Option<usize> = None;

        for raw_line in text.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            let keyword_end = line.find(char::is_whitespace).unwrap_or(line.len());
            let keyword = line[..keyword_end].to_ascii_uppercase();
            let remainder = line[keyword_end..].trim_start();
            match keyword.as_str() {
                "REM" | "TITLE" | "PERFORMER" | "SONGWRITER" | "FLAGS" | "CATALOG" | "ISRC" => {}
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
        let text = fs::read_to_string(path)?;
        let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
        let track_count = lines
            .next()
            .ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "gdi `{}` is missing its track count header",
                    path.display()
                ))
            })?
            .parse::<usize>()
            .map_err(|_| {
                RomWeaverError::Validation(format!(
                    "gdi `{}` has an invalid track count header",
                    path.display()
                ))
            })?;
        if track_count == 0 {
            return Err(RomWeaverError::Validation(format!(
                "gdi `{}` does not define any tracks",
                path.display()
            )));
        }

        let mut tracks = Vec::with_capacity(track_count);
        for line in lines {
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

    fn read_disc_tracks(&self, chd: &ChdFile, kind: DiscKind) -> Result<DiscLayout> {
        let mut tracks = Vec::new();
        for index in 0..99_u32 {
            let Some(metadata) = chd
                .read_metadata(kind.metadata_tag(), index)
                .map_err(|error| RomWeaverError::Validation(error.to_string()))?
            else {
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
        std::env::temp_dir().join(format!(
            "rom-weaver-{stem}-{}-{timestamp}{extension}",
            std::process::id()
        ))
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

    fn write_disc_metadata(&self, chd: &ChdFile, layout: &DiscLayout) -> Result<()> {
        for (index, track) in layout.tracks.iter().enumerate() {
            let pgtype = if track.pregap_has_data {
                format!("V{}", track.mode.metadata_label())
            } else {
                track.mode.metadata_label().to_string()
            };
            let mut metadata = match layout.kind {
                DiscKind::CdRom => format!(
                    "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                    track.number,
                    track.mode.metadata_label(),
                    track.frames,
                    track.pregap_frames,
                    pgtype,
                    track.postgap_frames
                ),
                DiscKind::GdRom => format!(
                    "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PAD:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                    track.number,
                    track.mode.metadata_label(),
                    track.frames,
                    track.pad_frames,
                    track.pregap_frames,
                    pgtype,
                    track.postgap_frames
                ),
            }
            .into_bytes();
            metadata.push(0);
            chd.write_metadata(rom_weaver_chd_sys::Metadata {
                tag: layout.kind.metadata_tag(),
                index: index as u32,
                flags: CHD_METADATA_FLAG_CHECKSUM,
                data: &metadata,
            })
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        }
        Ok(())
    }

    fn extract_cd(
        &self,
        request: &ContainerExtractRequest,
        execution: rom_weaver_core::ThreadExecution,
    ) -> Result<OperationReport> {
        let chd = ChdFile::open(&request.source, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
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
        let extract_result = ChdFile::extract_to_file(&request.source, None, &temp_path)
            .map_err(|error| RomWeaverError::Validation(error.to_string()));
        if extract_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        let _ = extract_result?;

        let first_data_bytes = layout
            .tracks
            .first()
            .map(|track| track.mode.data_bytes())
            .unwrap_or(2352);
        let single_bin = layout
            .tracks
            .iter()
            .all(|track| track.mode.data_bytes() == first_data_bytes);

        let build_result: Result<(bool, Option<PathBuf>)> = (|| {
            let mut reader = BufReader::new(File::open(&temp_path)?);
            let mut cue_writer = BufWriter::new(File::create(&cue_path)?);
            let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
            let mut omitted_subcode = false;
            let single_bin_path = if single_bin {
                Some(request.out_dir.join(format!("{stem}.bin")))
            } else {
                None
            };

            if let Some(bin_path) = single_bin_path.as_ref() {
                cue_writer.write_all(format!("FILE \"{stem}.bin\" BINARY\n").as_bytes())?;
                let mut bin_writer = BufWriter::new(File::create(bin_path)?);
                let mut output_frame_offset = 0_u32;
                for track in &layout.tracks {
                    cue_writer.write_all(
                        format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label())
                            .as_bytes(),
                    )?;
                    if track.pregap_frames > 0 && track.pregap_has_data {
                        cue_writer.write_all(
                            format!("    INDEX 00 {}\n", self.format_msf(output_frame_offset))
                                .as_bytes(),
                        )?;
                        cue_writer.write_all(
                            format!(
                                "    INDEX 01 {}\n",
                                self.format_msf(output_frame_offset + track.pregap_frames)
                            )
                            .as_bytes(),
                        )?;
                    } else if track.pregap_frames > 0 {
                        cue_writer.write_all(
                            format!("    PREGAP {}\n", self.format_msf(track.pregap_frames))
                                .as_bytes(),
                        )?;
                        cue_writer.write_all(
                            format!("    INDEX 01 {}\n", self.format_msf(output_frame_offset))
                                .as_bytes(),
                        )?;
                    } else {
                        cue_writer.write_all(
                            format!("    INDEX 01 {}\n", self.format_msf(output_frame_offset))
                                .as_bytes(),
                        )?;
                    }
                    if track.postgap_frames > 0 {
                        cue_writer.write_all(
                            format!("    POSTGAP {}\n", self.format_msf(track.postgap_frames))
                                .as_bytes(),
                        )?;
                    }

                    let data_frames = track.frames.saturating_sub(track.pad_frames);
                    for _ in 0..data_frames {
                        reader.read_exact(&mut frame)?;
                        let data = &mut frame[..track.mode.data_bytes()];
                        if track.has_subcode {
                            omitted_subcode = true;
                        }
                        track.mode.swap_audio_bytes(data);
                        bin_writer.write_all(data)?;
                    }
                    for _ in 0..track.pad_frames {
                        reader.read_exact(&mut frame)?;
                    }
                    output_frame_offset = output_frame_offset.saturating_add(data_frames);
                }
                bin_writer.flush()?;
            } else {
                for track in &layout.tracks {
                    let track_name = self.track_output_name(stem, track.number);
                    let track_path = request.out_dir.join(&track_name);
                    cue_writer.write_all(format!("FILE \"{track_name}\" BINARY\n").as_bytes())?;
                    cue_writer.write_all(
                        format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label())
                            .as_bytes(),
                    )?;
                    if track.pregap_frames > 0 && track.pregap_has_data {
                        cue_writer.write_all(b"    INDEX 00 00:00:00\n")?;
                        cue_writer.write_all(
                            format!("    INDEX 01 {}\n", self.format_msf(track.pregap_frames))
                                .as_bytes(),
                        )?;
                    } else if track.pregap_frames > 0 {
                        cue_writer.write_all(
                            format!("    PREGAP {}\n", self.format_msf(track.pregap_frames))
                                .as_bytes(),
                        )?;
                        cue_writer.write_all(b"    INDEX 01 00:00:00\n")?;
                    } else {
                        cue_writer.write_all(b"    INDEX 01 00:00:00\n")?;
                    }
                    if track.postgap_frames > 0 {
                        cue_writer.write_all(
                            format!("    POSTGAP {}\n", self.format_msf(track.postgap_frames))
                                .as_bytes(),
                        )?;
                    }

                    let mut track_writer = BufWriter::new(File::create(track_path)?);
                    let data_frames = track.frames.saturating_sub(track.pad_frames);
                    for _ in 0..data_frames {
                        reader.read_exact(&mut frame)?;
                        let data = &mut frame[..track.mode.data_bytes()];
                        if track.has_subcode {
                            omitted_subcode = true;
                        }
                        track.mode.swap_audio_bytes(data);
                        track_writer.write_all(data)?;
                    }
                    for _ in 0..track.pad_frames {
                        reader.read_exact(&mut frame)?;
                    }
                    track_writer.flush()?;
                }
            }

            cue_writer.flush()?;
            Ok((omitted_subcode, single_bin_path))
        })();

        let _ = fs::remove_file(&temp_path);
        let (omitted_subcode, single_bin_path) = build_result?;
        let suffix = if omitted_subcode {
            "; subcode data was omitted from cue/bin output"
        } else {
            ""
        };

        let label = if let Some(bin_path) = single_bin_path {
            format!(
                "extracted `{}` to `{}` and `{}` (cd, {}){}",
                request.source.display(),
                cue_path.display(),
                bin_path.display(),
                self.header_codec_label(header),
                suffix
            )
        } else {
            format!(
                "extracted `{}` to `{}` and per-track bin files (cd, {}){}",
                request.source.display(),
                cue_path.display(),
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

    fn extract_gd(
        &self,
        request: &ContainerExtractRequest,
        execution: rom_weaver_core::ThreadExecution,
    ) -> Result<OperationReport> {
        let chd = ChdFile::open(&request.source, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
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
        let extract_result = ChdFile::extract_to_file(&request.source, None, &temp_path)
            .map_err(|error| RomWeaverError::Validation(error.to_string()));
        if extract_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        let _ = extract_result?;

        let build_result: Result<bool> = (|| {
            let mut reader = BufReader::new(File::open(&temp_path)?);
            let mut gdi_writer = BufWriter::new(File::create(&gdi_path)?);
            let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
            let mut omitted_subcode = false;
            let mut physframeofs = 0_u32;

            gdi_writer.write_all(format!("{}\n", layout.tracks.len()).as_bytes())?;
            for track in &layout.tracks {
                let (track_type, sector_size) = track.mode.gdi_track_descriptor()?;
                let track_name = self.track_output_name(stem, track.number);
                let track_path = request.out_dir.join(&track_name);
                gdi_writer.write_all(
                    format!(
                        "{} {} {} {} {} 0\n",
                        track.number, physframeofs, track_type, sector_size, track_name
                    )
                    .as_bytes(),
                )?;

                let mut track_writer = BufWriter::new(File::create(track_path)?);
                let data_frames = track.frames.saturating_sub(track.pad_frames);
                for _ in 0..data_frames {
                    reader.read_exact(&mut frame)?;
                    let data = &mut frame[..track.mode.data_bytes()];
                    if track.has_subcode {
                        omitted_subcode = true;
                    }
                    track.mode.swap_audio_bytes(data);
                    track_writer.write_all(data)?;
                }
                for _ in 0..track.pad_frames {
                    reader.read_exact(&mut frame)?;
                }
                track_writer.flush()?;
                physframeofs = physframeofs.saturating_add(track.frames);
            }

            gdi_writer.flush()?;
            Ok(omitted_subcode)
        })();

        let _ = fs::remove_file(&temp_path);
        let omitted_subcode = build_result?;
        let suffix = if omitted_subcode {
            "; subcode data was omitted from gdi output"
        } else {
            ""
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(CHD.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` and per-track gd files (gd, {}){}",
                request.source.display(),
                gdi_path.display(),
                self.header_codec_label(header),
                suffix
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create_uncompressed(
        &self,
        input: &Path,
        output: &Path,
        logical_bytes: u64,
        create_kind: &ChdCreateKind,
    ) -> Result<rom_weaver_chd_sys::ChdHeader> {
        let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, ChdCodec::NONE);
        let mut chd = ChdFile::create(
            output,
            None,
            &CreateOptions {
                logical_bytes,
                hunk_bytes,
                unit_bytes: self.unit_bytes(create_kind),
                compression: [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
            },
        )
        .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        let mut reader = BufReader::new(File::open(input)?);
        let mut buffer = vec![0_u8; usize::try_from(chd.header().hunk_bytes).unwrap_or(4096)];

        for hunk_index in 0..chd.header().hunk_count {
            buffer.fill(0);
            let mut filled = 0;
            while filled < buffer.len() {
                let read = reader.read(&mut buffer[filled..])?;
                if read == 0 {
                    break;
                }
                filled += read;
            }
            chd.write_hunk(hunk_index, &buffer)
                .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
            if filled < buffer.len() {
                break;
            }
        }

        self.write_create_metadata(&chd, create_kind)?;
        chd.refresh_header()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))
    }

    fn create_compressed(
        &self,
        input: &Path,
        output: &Path,
        logical_bytes: u64,
        create_kind: &ChdCreateKind,
        codec: ChdCodec,
    ) -> Result<rom_weaver_chd_sys::ChdHeader> {
        let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, codec);
        ChdFile::compress_file(
            input,
            output,
            None,
            &CreateOptions {
                logical_bytes,
                hunk_bytes,
                unit_bytes: self.unit_bytes(create_kind),
                compression: [codec, ChdCodec::NONE, ChdCodec::NONE, ChdCodec::NONE],
            },
        )
        .map_err(|error| RomWeaverError::Validation(error.to_string()))?;

        let mut chd = ChdFile::open_writable(output, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        self.write_create_metadata(&chd, create_kind)?;
        chd.refresh_header()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))
    }

    fn infer_create_kind(&self, input: &Path, logical_bytes: u64) -> Result<ChdCreateKind> {
        let extension = input
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        match extension.as_deref() {
            Some("iso") => {
                self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                Ok(ChdCreateKind::Dvd)
            }
            Some("img") | Some("ima") => Ok(ChdCreateKind::HardDisk(
                self.infer_hd_geometry(logical_bytes)?,
            )),
            Some("cue") => Ok(ChdCreateKind::Disc(self.parse_cue_file(input)?)),
            Some("gdi") => Ok(ChdCreateKind::Disc(self.parse_gdi_file(input)?)),
            _ => Ok(ChdCreateKind::Raw),
        }
    }

    fn unit_bytes(&self, create_kind: &ChdCreateKind) -> u32 {
        match create_kind {
            ChdCreateKind::Raw => 1,
            ChdCreateKind::HardDisk(geometry) => geometry.bytes_per_sector,
            ChdCreateKind::Dvd => Self::DVD_SECTOR_BYTES,
            ChdCreateKind::Disc(_) => Self::CD_FRAME_BYTES,
        }
    }

    fn hunk_bytes(&self, create_kind: &ChdCreateKind, logical_bytes: u64, codec: ChdCodec) -> u32 {
        match create_kind {
            ChdCreateKind::Disc(_) if codec != ChdCodec::NONE => {
                let total_frames = logical_bytes / u64::from(Self::CD_FRAME_BYTES);
                if total_frames <= 1 {
                    Self::CD_HUNK_BYTES
                } else {
                    let frames_per_hunk = total_frames.div_ceil(2).min(8);
                    u32::try_from(frames_per_hunk)
                        .unwrap_or(8)
                        .saturating_mul(Self::CD_FRAME_BYTES)
                }
            }
            ChdCreateKind::Disc(_) => Self::CD_HUNK_BYTES,
            _ => Self::DEFAULT_HUNK_BYTES,
        }
    }

    fn infer_hd_geometry(&self, logical_bytes: u64) -> Result<HdGeometry> {
        self.ensure_multiple_of(logical_bytes, Self::HD_SECTOR_BYTES, "hard-disk image")?;
        let total_sectors = logical_bytes / u64::from(Self::HD_SECTOR_BYTES);
        const CANDIDATES: &[(u32, u32)] = &[
            (255, 63),
            (240, 63),
            (128, 63),
            (64, 63),
            (32, 63),
            (16, 63),
            (16, 32),
            (16, 16),
            (8, 32),
            (8, 16),
            (4, 16),
            (2, 16),
            (1, 1),
        ];

        for &(heads, sectors) in CANDIDATES {
            let span = u64::from(heads) * u64::from(sectors);
            if span == 0 || total_sectors % span != 0 {
                continue;
            }

            let cylinders = total_sectors / span;
            if cylinders <= u64::from(u32::MAX) {
                return Ok(HdGeometry {
                    cylinders: cylinders as u32,
                    heads,
                    sectors,
                    bytes_per_sector: Self::HD_SECTOR_BYTES,
                });
            }
        }

        Err(RomWeaverError::Validation(format!(
            "hard-disk image `{logical_bytes}` bytes is too large for the current synthetic geometry heuristic"
        )))
    }

    fn ensure_multiple_of(&self, logical_bytes: u64, unit_bytes: u32, label: &str) -> Result<()> {
        if logical_bytes % u64::from(unit_bytes) == 0 {
            Ok(())
        } else {
            Err(RomWeaverError::Validation(format!(
                "{label} size must be a multiple of {unit_bytes} bytes"
            )))
        }
    }

    fn write_create_metadata(&self, chd: &ChdFile, create_kind: &ChdCreateKind) -> Result<()> {
        match create_kind {
            ChdCreateKind::Raw => Ok(()),
            ChdCreateKind::Dvd => chd
                .write_metadata(rom_weaver_chd_sys::Metadata {
                    tag: DVD_METADATA_TAG,
                    index: 0,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: b"\0",
                })
                .map_err(|error| RomWeaverError::Validation(error.to_string())),
            ChdCreateKind::HardDisk(geometry) => {
                let mut metadata = format!(
                    "CYLS:{},HEADS:{},SECS:{},BPS:{}",
                    geometry.cylinders, geometry.heads, geometry.sectors, geometry.bytes_per_sector
                )
                .into_bytes();
                metadata.push(0);
                chd.write_metadata(rom_weaver_chd_sys::Metadata {
                    tag: HARD_DISK_METADATA_TAG,
                    index: 0,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: &metadata,
                })
                .map_err(|error| RomWeaverError::Validation(error.to_string()))
            }
            ChdCreateKind::Disc(layout) => self.write_disc_metadata(chd, layout),
        }
    }
}

impl ContainerHandler for ChdContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &CHD
    }

    fn probe(&self, _source: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.ensure_backend()?;
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let chd = ChdFile::open(&request.source, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        let header = chd.header();
        let media_kind = chd
            .media_kind()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
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

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.ensure_backend()?;
        if !request.selections.is_empty() {
            return Err(RomWeaverError::Validation(
                "chd extract does not support --select yet".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let chd = ChdFile::open(&request.source, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        let media_kind = chd
            .media_kind()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        if media_kind == ChdMediaKind::CdRom {
            return self.extract_cd(request, execution);
        }
        if media_kind == ChdMediaKind::GdRom {
            return self.extract_gd(request, execution);
        }
        fs::create_dir_all(&request.out_dir)?;
        let output_path = request
            .out_dir
            .join(self.extract_name(&request.source, media_kind)?);
        let header = ChdFile::extract_to_file(&request.source, None, &output_path)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
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
        self.ensure_backend()?;
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "chd create currently requires exactly one input file".into(),
            ));
        }
        if request.level.is_some() {
            return Err(RomWeaverError::Validation(
                "chd create does not support --level yet".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let input = &request.inputs[0];
        let input_bytes = fs::metadata(input)?.len();
        let create_kind = self.infer_create_kind(input, input_bytes)?;
        let codec = self.resolve_codec(request.codec.as_deref(), &create_kind)?;
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

        let create_result = if codec == ChdCodec::NONE {
            self.create_uncompressed(source_path, &request.output, logical_bytes, &create_kind)
        } else {
            self.create_compressed(
                source_path,
                &request.output,
                logical_bytes,
                &create_kind,
                codec,
            )
        };
        if let Some(path) = staged_input.as_ref() {
            let _ = fs::remove_file(path);
        }
        let header = create_result?;
        let created_chd = ChdFile::open(&request.output, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        let media_kind = created_chd
            .media_kind()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;

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
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ContainerRegistry;

    #[test]
    fn registry_contains_planned_formats() {
        let registry = ContainerRegistry::new();
        let names = registry
            .handlers()
            .iter()
            .map(|handler| handler.descriptor().name)
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "zip", "zipx", "7z", "tar", "tar.gz", "tar.bz2", "tar.xz", "chd", "rvz", "z3ds"
            ]
        );
    }
}
