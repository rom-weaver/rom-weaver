use super::*;

pub struct ChdContainerHandler;

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

impl DiscLayout {
    fn logical_bytes(&self) -> Result<u64> {
        self.tracks.iter().try_fold(0_u64, |total, track| {
            let track_bytes = u64::from(track.frames)
                .checked_mul(u64::from(ChdContainerHandler::CD_FRAME_BYTES))
                .ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "disc track {} is too large for current chd support",
                        track.number
                    ))
                })?;
            total.checked_add(track_bytes).ok_or_else(|| {
                RomWeaverError::Validation(
                    "disc logical size exceeded current chd limits".to_string(),
                )
            })
        })
    }

    /// Apply MAME's CD track padding to a freshly built CD-ROM layout.
    ///
    /// Each track's hunk-stream frame count is rounded up to a multiple of
    /// `CD_TRACK_PADDING`; `frames` becomes the padded total and `pad_frames`
    /// records the zero-filled remainder. The track metadata still reports the
    /// unpadded data count (`frames - pad_frames`). GD-ROM carries explicit
    /// `PAD:` metadata, so this is a no-op for that media.
    ///
    /// Assumes each track currently holds its unpadded data frame count with
    /// `pad_frames == 0`, so it must run exactly once per layout.
    fn apply_cd_track_padding(&mut self) {
        if self.kind != DiscKind::CdRom {
            return;
        }
        let padding = ChdContainerHandler::CD_TRACK_PADDING;
        for track in &mut self.tracks {
            let data_frames = track.frames;
            let pad = (padding - data_frames % padding) % padding;
            track.pad_frames = pad;
            track.frames = data_frames.saturating_add(pad);
        }
    }

    /// Redirect tracks whose resolved `file_path` matches an override's
    /// `original_path` to the override's source (an alternate path or in-memory
    /// bytes), so a freshly produced track is read in place of the original
    /// while every untouched track still reads from the source disc. A
    /// shared-bin FILE backing several tracks redirects them all, each keeping
    /// its own `file_offset_bytes`. Errors if an override matches no track —
    /// that would silently emit the original (unpatched) bytes and break parity.
    fn apply_input_overrides(&mut self, overrides: &[CreateInputOverride]) -> Result<()> {
        for ovr in overrides {
            let mut matched = false;
            for track in &mut self.tracks {
                if track.file_path != ovr.original_path {
                    continue;
                }
                match &ovr.source {
                    CreateInputSource::Path(path) => {
                        track.file_path = path.clone();
                        track.memory_source = None;
                    }
                    CreateInputSource::Bytes(bytes) => {
                        track.memory_source = Some(Arc::clone(bytes));
                    }
                }
                matched = true;
            }
            if !matched {
                return Err(RomWeaverError::Validation(format!(
                    "disc create track override for `{}` matched no track in the layout",
                    ovr.original_path.display()
                )));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AvProfile {
    frame_bytes: u32,
    fps: u32,
    fpsfrac: u32,
    width: u32,
    height: u32,
    interlaced: u32,
    channels: u32,
    sample_rate: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiscTrack {
    number: u32,
    mode: DiscTrackMode,
    file_path: PathBuf,
    /// When set, the track's bytes are read from this in-memory buffer instead
    /// of `file_path` — used for a freshly produced track (e.g. a patched track)
    /// sourced from memory rather than a staged file. `file_offset_bytes` still
    /// indexes into the buffer, matching the file case so the emitted stream is
    /// byte-identical.
    memory_source: Option<Arc<[u8]>>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FlacSampleByteOrder {
    LittleEndian,
    BigEndian,
}

/// Per-track byte source for [`DiscImageReader`]: a buffered file (the default)
/// or an in-memory cursor for a track sourced from memory.
enum TrackReader {
    File(BufReader<File>),
    Memory(Cursor<Arc<[u8]>>),
}

impl Read for TrackReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::File(reader) => reader.read(buf),
            Self::Memory(reader) => reader.read(buf),
        }
    }
}

struct DiscImageReader<'a> {
    tracks: &'a [DiscTrack],
    track_index: usize,
    track_initialized: bool,
    track_reader: Option<TrackReader>,
    track_data_frames_remaining: u32,
    track_pad_frames_remaining: u32,
    frame: Vec<u8>,
    frame_cursor: usize,
    frame_len: usize,
    data: Vec<u8>,
}

impl<'a> DiscImageReader<'a> {
    fn new(layout: &'a DiscLayout) -> Self {
        Self {
            tracks: &layout.tracks,
            track_index: 0,
            track_initialized: false,
            track_reader: None,
            track_data_frames_remaining: 0,
            track_pad_frames_remaining: 0,
            frame: vec![0_u8; ChdContainerHandler::CD_FRAME_BYTES as usize],
            frame_cursor: 0,
            frame_len: 0,
            data: Vec::new(),
        }
    }

    fn load_next_frame(&mut self) -> io::Result<bool> {
        loop {
            if self.track_index >= self.tracks.len() {
                self.track_reader = None;
                return Ok(false);
            }

            if !self.track_initialized {
                let track = &self.tracks[self.track_index];
                self.track_data_frames_remaining = track.frames.saturating_sub(track.pad_frames);
                self.track_pad_frames_remaining = track.pad_frames;
                self.track_initialized = true;
            }

            if self.track_data_frames_remaining == 0 && self.track_pad_frames_remaining == 0 {
                self.track_index += 1;
                self.track_initialized = false;
                self.track_reader = None;
                continue;
            }

            let track = &self.tracks[self.track_index];
            if self.track_data_frames_remaining > 0 {
                if self.track_reader.is_none() {
                    self.track_reader = Some(match &track.memory_source {
                        Some(bytes) => {
                            let mut reader = Cursor::new(Arc::clone(bytes));
                            reader.seek(SeekFrom::Start(track.file_offset_bytes))?;
                            TrackReader::Memory(reader)
                        }
                        None => {
                            let mut reader = BufReader::new(File::open(&track.file_path)?);
                            reader.seek(SeekFrom::Start(track.file_offset_bytes))?;
                            TrackReader::File(reader)
                        }
                    });
                }
                let data_len = track.mode.data_bytes();
                if self.data.len() != data_len {
                    self.data.resize(data_len, 0);
                }
                self.track_reader
                    .as_mut()
                    .expect("track reader should be initialized")
                    .read_exact(&mut self.data)?;
                if track.swap_audio_on_read {
                    track.mode.swap_audio_bytes(&mut self.data);
                }
                self.frame.fill(0);
                self.frame[..data_len].copy_from_slice(&self.data);
                self.frame_cursor = 0;
                self.frame_len = self.frame.len();
                self.track_data_frames_remaining -= 1;
                if self.track_data_frames_remaining == 0 && self.track_pad_frames_remaining == 0 {
                    self.track_index += 1;
                    self.track_initialized = false;
                    self.track_reader = None;
                }
                return Ok(true);
            }

            self.frame.fill(0);
            self.frame_cursor = 0;
            self.frame_len = self.frame.len();
            self.track_pad_frames_remaining -= 1;
            if self.track_data_frames_remaining == 0 && self.track_pad_frames_remaining == 0 {
                self.track_index += 1;
                self.track_initialized = false;
                self.track_reader = None;
            }
            return Ok(true);
        }
    }
}

impl Read for DiscImageReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }

        let mut written = 0_usize;
        while written < output.len() {
            if self.frame_cursor >= self.frame_len && !self.load_next_frame()? {
                break;
            }
            let available = self.frame_len.saturating_sub(self.frame_cursor);
            if available == 0 {
                break;
            }
            let write_len = available.min(output.len() - written);
            output[written..written + write_len]
                .copy_from_slice(&self.frame[self.frame_cursor..self.frame_cursor + write_len]);
            self.frame_cursor += write_len;
            written += write_len;
        }
        Ok(written)
    }
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

    fn pregap_metadata_label(self) -> &'static str {
        match self {
            Self::Mode1Raw => "MODE1",
            Self::Mode2Raw => "MODE2",
            _ => self.metadata_label(),
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
    Av(AvProfile),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChdCreateModeOverride {
    Cd,
    Gd,
    Dvd,
    Raw,
    HardDisk,
    Av,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChdCompressionPlan {
    codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
    primary_codec: ChdCodec,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RustCompressedHunkEntry {
    compression_type: u8,
    offset: u64,
    length: u32,
    crc16: u16,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
struct HunkHashKey {
    crc16: u16,
    sha1: [u8; 20],
}

struct ParentReuseIndex {
    by_hash: HashMap<HunkHashKey, u64>,
    sha1: [u8; 20],
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RustMetadataEntry {
    tag: u32,
    flags: u8,
    data: Vec<u8>,
}

#[derive(Default)]
struct MsbBitWriter {
    bytes: Vec<u8>,
    bit_len: usize,
}

impl MsbBitWriter {
    fn new() -> Self {
        Self::default()
    }

    fn write_bits(&mut self, value: u64, bit_count: u8) {
        if bit_count == 0 {
            return;
        }
        for shift in (0..bit_count).rev() {
            let bit = ((value >> shift) & 1) as u8;
            let byte_index = self.bit_len / 8;
            if byte_index == self.bytes.len() {
                self.bytes.push(0);
            }
            let bit_index = 7 - (self.bit_len % 8);
            self.bytes[byte_index] |= bit << bit_index;
            self.bit_len += 1;
        }
    }

    fn align_to_byte(&mut self) {
        let remainder = self.bit_len % 8;
        if remainder == 0 {
            return;
        }
        self.write_bits(0, (8 - remainder) as u8);
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

const CDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'C', b'D');
const CDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'T', b'R');
const GDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'T');
const AV_METADATA_TAG: u32 = make_tag(b'A', b'V', b'A', b'V');
const AV_LD_METADATA_TAG: u32 = make_tag(b'A', b'V', b'L', b'D');

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

#[path = "cd_sector_ecc.rs"]
mod cd_sector_ecc;
#[path = "codec_encoders.rs"]
mod codec_encoders;
#[path = "compressed_map.rs"]
mod compressed_map;
#[path = "core.rs"]
mod core;
#[path = "create_pipeline.rs"]
mod create_pipeline;
#[path = "disc_extract.rs"]
mod disc_extract;
#[path = "handler_trait.rs"]
mod handler_trait;
#[path = "header_metadata.rs"]
mod header_metadata;
#[path = "hunk_compression.rs"]
mod hunk_compression;
#[path = "infer.rs"]
mod infer;
#[path = "read_session.rs"]
mod read_session;

use cd_sector_ecc::CD_SYNC_HEADER;
use create_pipeline::CompressedCreateParams;
use hunk_compression::ChdCompressionScratch;
use read_session::ChdReadSession;

#[cfg(test)]
#[path = "../../tests/unit/chd.rs"]
mod chd_tests;
