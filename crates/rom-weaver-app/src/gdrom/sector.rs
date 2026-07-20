//! CD/GD-ROM track sector handling.
//!
//! A data track on a CD or GD-ROM stores its 2048-byte ISO9660 logical sectors
//! wrapped in physical sectors that may also carry a 12-byte sync pattern, a
//! 4-byte address/mode header and trailing EDC/ECC error-correction bytes
//! (`MODE1/2352`), or a smaller framing (`MODE2/2336`), or none at all when the
//! track is already "cooked" to bare 2048-byte sectors. Reading an ISO9660
//! filesystem out of a track therefore means stripping that framing to recover
//! the user-data payload of each sector.
//!
//! This module detects a track's physical sector format and presents it as a
//! stream of cooked 2048-byte logical sectors. It performs no error correction
//! and never rewrites EDC/ECC - that belongs to the (write-side) GD-ROM author,
//! not the reader.

use std::io::{Read, Seek, SeekFrom};

use rom_weaver_core::{Result, RomWeaverError};

/// The size of one ISO9660 logical sector (the user-data payload of a physical
/// sector), in bytes.
pub const LOGICAL_SECTOR_SIZE: usize = 2048;

/// The 12-byte sync pattern that begins every raw (`/2352`) Mode 1 / Mode 2
/// physical sector: `00 FF*10 00`.
const SYNC_PATTERN: [u8; 12] = [
    0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00,
];

/// The physical layout of a track's sectors, i.e. how to find the 2048-byte
/// user-data payload within each physical sector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectorFormat {
    /// Bytes per physical sector on the track (2048, 2336, or 2352).
    pub physical_size: u32,
    /// Byte offset of the 2048-byte user-data payload within a physical sector.
    pub data_offset: u32,
}

impl SectorFormat {
    /// Bare 2048-byte logical sectors with no framing (an `.iso`-style image).
    pub const COOKED_2048: SectorFormat = SectorFormat {
        physical_size: 2048,
        data_offset: 0,
    };
    /// `MODE1/2352`: 12-byte sync + 3-byte address + 1-byte mode, then 2048
    /// user bytes, then EDC/ECC. This is the usual Dreamcast data-track layout.
    pub const MODE1_2352: SectorFormat = SectorFormat {
        physical_size: 2352,
        data_offset: 16,
    };
    /// `MODE2/2352` Form 1: sync + header + an 8-byte subheader precede the
    /// 2048 user bytes.
    pub const MODE2_FORM1_2352: SectorFormat = SectorFormat {
        physical_size: 2352,
        data_offset: 24,
    };
    /// `MODE2/2336`: an 8-byte subheader precedes the 2048 user bytes, with no
    /// sync/header.
    pub const MODE2_2336: SectorFormat = SectorFormat {
        physical_size: 2336,
        data_offset: 8,
    };

    /// Detect the sector format of a track from its leading bytes and total
    /// length. `head` must hold at least the first 16 bytes of the track;
    /// `track_len` is the track file's total size in bytes.
    ///
    /// Raw (`/2352`) tracks are recognized by their sync pattern, then split by
    /// the mode byte. Tracks without a sync pattern are taken to be cooked 2048
    /// sectors when the length divides evenly, else `MODE2/2336`.
    pub fn detect(head: &[u8], track_len: u64) -> Result<SectorFormat> {
        if head.len() >= 16 && head[..12] == SYNC_PATTERN {
            let mode = head[15];
            let format = match mode {
                1 => SectorFormat::MODE1_2352,
                2 => SectorFormat::MODE2_FORM1_2352,
                other => {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported raw sector mode byte {other:#04x}; expected MODE1 (1) or MODE2 (2)"
                    )));
                }
            };
            return Ok(format);
        }
        if track_len.is_multiple_of(2048) {
            return Ok(SectorFormat::COOKED_2048);
        }
        if track_len.is_multiple_of(2336) {
            return Ok(SectorFormat::MODE2_2336);
        }
        if track_len.is_multiple_of(2352) {
            // No sync pattern but a 2352-aligned length: treat as MODE1 raw.
            return Ok(SectorFormat::MODE1_2352);
        }
        Err(RomWeaverError::Validation(format!(
            "cannot determine sector format: {track_len} bytes is not a multiple of 2048, 2336, or 2352 and has no sync pattern"
        )))
    }

    /// The number of logical sectors a track of `track_len` bytes holds in this
    /// format.
    pub fn logical_sector_count(&self, track_len: u64) -> u64 {
        track_len / u64::from(self.physical_size)
    }
}

/// Reads a track's cooked 2048-byte logical sectors on demand.
///
/// Holds the underlying seekable track source and the detected [`SectorFormat`]
/// and translates logical-sector requests into physical seeks + payload slices.
pub struct TrackSectors<R> {
    reader: R,
    format: SectorFormat,
    logical_sectors: u64,
}

impl<R: Read + Seek> TrackSectors<R> {
    /// Open a track, detecting its sector format from the first physical sector
    /// and the total length. Leaves the reader positioned arbitrarily; all
    /// reads seek explicitly.
    pub fn open(mut reader: R) -> Result<TrackSectors<R>> {
        let track_len = reader.seek(SeekFrom::End(0))?;
        let mut head = [0u8; 16];
        let head_len = if track_len >= 16 {
            reader.seek(SeekFrom::Start(0))?;
            reader.read_exact(&mut head)?;
            16
        } else {
            0
        };
        let format = SectorFormat::detect(&head[..head_len], track_len)?;
        let logical_sectors = format.logical_sector_count(track_len);
        tracing::debug!(
            track_len,
            physical_size = format.physical_size,
            data_offset = format.data_offset,
            logical_sectors,
            "opened track"
        );
        Ok(TrackSectors {
            reader,
            format,
            logical_sectors,
        })
    }

    /// Open a track with a caller-supplied sector format, skipping detection.
    pub fn with_format(mut reader: R, format: SectorFormat) -> Result<TrackSectors<R>> {
        let track_len = reader.seek(SeekFrom::End(0))?;
        Ok(TrackSectors {
            reader,
            format,
            logical_sectors: format.logical_sector_count(track_len),
        })
    }

    /// The detected sector format.
    pub fn format(&self) -> SectorFormat {
        self.format
    }

    /// The number of logical sectors available in the track.
    pub fn logical_sector_count(&self) -> u64 {
        self.logical_sectors
    }

    /// Read the 2048-byte user-data payload of logical sector `index` (counted
    /// from the start of the track) into `out`.
    pub fn read_logical(&mut self, index: u64, out: &mut [u8; LOGICAL_SECTOR_SIZE]) -> Result<()> {
        if index >= self.logical_sectors {
            return Err(RomWeaverError::Validation(format!(
                "logical sector {index} is past end of track ({} sectors)",
                self.logical_sectors
            )));
        }
        let physical_pos =
            index * u64::from(self.format.physical_size) + u64::from(self.format.data_offset);
        self.reader.seek(SeekFrom::Start(physical_pos))?;
        self.reader.read_exact(out)?;
        Ok(())
    }

    /// Read `len` bytes of logical (cooked) data beginning at logical sector
    /// `start_sector`. Reads whole sectors and truncates to `len`.
    pub fn read_logical_range(&mut self, start_sector: u64, len: u64) -> Result<Vec<u8>> {
        // Validate the request against the track length up front. `len` and
        // `start_sector` derive from untrusted on-disc fields (extent LBAs and
        // sizes), so reject an overrun before reserving anything - otherwise a
        // bogus ~4 GiB length would trigger a huge speculative allocation
        // before the per-sector loop ever discovers the track is short.
        if start_sector > self.logical_sectors {
            return Err(RomWeaverError::Validation(format!(
                "logical sector {start_sector} is past end of track ({} sectors)",
                self.logical_sectors
            )));
        }
        let available_bytes =
            (self.logical_sectors - start_sector).saturating_mul(LOGICAL_SECTOR_SIZE as u64);
        if len > available_bytes {
            return Err(RomWeaverError::Validation(format!(
                "logical range of {len} bytes from sector {start_sector} overruns track ({available_bytes} bytes available)"
            )));
        }
        let capacity = usize::try_from(len).unwrap_or(0);
        let mut out = Vec::with_capacity(capacity);
        let mut sector = start_sector;
        let mut buf = [0u8; LOGICAL_SECTOR_SIZE];
        while (out.len() as u64) < len {
            self.read_logical(sector, &mut buf)?;
            let take = std::cmp::min(LOGICAL_SECTOR_SIZE as u64, len - out.len() as u64) as usize;
            out.extend_from_slice(&buf[..take]);
            sector += 1;
        }
        Ok(out)
    }
}
