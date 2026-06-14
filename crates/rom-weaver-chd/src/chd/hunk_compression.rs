use super::*;

std::thread_local! {
    /// Per-worker zstd compressor reused across hunks. At high levels the optimal-parser
    /// workspace is the dominant per-hunk cost; allocating one context per thread (instead of
    /// per `zstd_append` call - twice per CD hunk for the sector and subcode streams) keeps that
    /// cost off the hot path. The compression level is re-applied each call so pooled browser
    /// workers stay correct across operations.
    static CD_ZSTD_COMPRESSOR: std::cell::RefCell<Option<zstd::bulk::Compressor<'static>>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(Default)]
pub(super) struct ChdCompressionScratch {
    cd: CdHunkScratch,
}

#[derive(Default)]
pub(super) struct CdHunkScratch {
    sectors: Vec<u8>,
    raw_sectors: Vec<u8>,
    subcode: Vec<u8>,
    ecc_bitmap: Vec<u8>,
}

pub(super) struct PreparedCdHunk<'a> {
    frame_count: usize,
    sectors: &'a [u8],
    raw_sectors: Option<&'a [u8]>,
    subcode: &'a [u8],
    ecc_bitmap: &'a [u8],
}

#[derive(Default)]
pub(super) struct CdSharedCompressedStreams {
    deflate_subcode_default: Option<Vec<u8>>,
}

impl<'a> PreparedCdHunk<'a> {
    pub(super) fn sectors_for_codec(&self, codec: ChdCodec) -> &'a [u8] {
        if codec == ChdCodec::CD_FLAC {
            self.raw_sectors.unwrap_or(self.sectors)
        } else {
            self.sectors
        }
    }
}

impl ChdContainerHandler {
    #[cfg(any(test, feature = "test-utils"))]
    pub fn encode_cd_zlib_payload_for_tests(&self, hunk: &[u8]) -> Result<Vec<u8>> {
        self.compress_rust_cd_hunk(ChdCodec::CD_ZLIB, 0, hunk)
    }

    pub(super) fn compress_rust_hunk(
        &self,
        create_kind: &ChdCreateKind,
        primary_codec: ChdCodec,
        compression_level: i32,
        hunk: &[u8],
    ) -> Result<Vec<u8>> {
        trace!(
            codec = ?primary_codec,
            raw = hunk.len(),
            level = compression_level,
            "chd hunk encode"
        );
        if matches!(create_kind, ChdCreateKind::Disc(_)) {
            return self.compress_rust_cd_hunk(primary_codec, compression_level, hunk);
        }
        match primary_codec {
            ChdCodec::ZSTD => zstd_compress(hunk, compression_level).map_err(|error| {
                RomWeaverError::Validation(format!("zstd compression failed: {error}"))
            }),
            ChdCodec::ZLIB => {
                let compression = if compression_level <= 0 {
                    GzipCompression::default()
                } else {
                    GzipCompression::new(compression_level.clamp(1, 9) as u32)
                };
                let mut encoder = DeflateEncoder::new(Vec::new(), compression);
                encoder.write_all(hunk).map_err(|error| {
                    RomWeaverError::Validation(format!("zlib compression failed: {error}"))
                })?;
                encoder.finish().map_err(|error| {
                    RomWeaverError::Validation(format!("zlib compression failed: {error}"))
                })
            }
            ChdCodec::LZMA => {
                let lzma_level = Self::resolved_chd_lzma_level(compression_level);
                Self::compress_lzma_raw_no_header_no_eopm(hunk, lzma_level, "lzma")
            }
            ChdCodec::HUFFMAN => Ok(self.encode_huffman_identity_payload(hunk)),
            ChdCodec::AVHUFF => match create_kind {
                ChdCreateKind::Av(_) => self.encode_avhuff_chav_hunk(hunk),
                _ => Err(RomWeaverError::Unsupported(
                    UnsupportedOp::ChdAvhuffRequiresChavFrames,
                )),
            },
            ChdCodec::FLAC => {
                let mut encoded = Vec::new();
                encoded.push(b'L');
                encoded.extend(self.encode_flac_frame_stream(
                    hunk,
                    FlacSampleByteOrder::LittleEndian,
                    compression_level,
                )?);
                Ok(encoded)
            }
            other => Err(RomWeaverError::Unsupported(
                UnsupportedOp::ChdCodecForMedia {
                    codec: self.codec_label(other).to_string(),
                    scope: ChdMediaScope::CompressedMediaMode,
                },
            )),
        }
    }

    /// Returns true only when every sector in the hunk begins with the CD data-sector sync
    /// header. CDDA audio sectors are headerless raw PCM, so an all-sync-header hunk is
    /// positively data (not audio) and the FLAC trial cannot win on it; a mixed/audio hunk
    /// returns false and keeps FLAC in play, preserving chdman parity on audio tracks.
    pub(super) fn cd_hunk_is_all_data_sectors(hunk: &[u8]) -> bool {
        let frame_bytes = Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES;
        if hunk.is_empty() || !hunk.len().is_multiple_of(frame_bytes) {
            return false;
        }
        hunk.chunks_exact(frame_bytes)
            .all(|frame| frame.starts_with(&CD_SYNC_HEADER))
    }

    pub(super) fn compress_best_rust_hunk(
        &self,
        create_kind: &ChdCreateKind,
        primary_codec: ChdCodec,
        encodable_codecs: &[(u8, ChdCodec)],
        compression_level: i32,
        hunk: Vec<u8>,
        scratch: &mut ChdCompressionScratch,
    ) -> Result<(u8, Vec<u8>)> {
        if encodable_codecs.is_empty() {
            return Ok((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
        }

        let mut best: Option<(u8, Vec<u8>)> = None;
        if matches!(create_kind, ChdCreateKind::Disc(_)) {
            let has_flac = encodable_codecs
                .iter()
                .any(|(_, codec)| *codec == ChdCodec::CD_FLAC);
            let has_non_flac = encodable_codecs
                .iter()
                .any(|(_, codec)| *codec != ChdCodec::CD_FLAC);
            // FLAC only ever wins on CDDA audio; skip its trial when the hunk is provably all
            // data sectors and at least one other codec remains to carry the result.
            let skip_flac = has_flac && has_non_flac && Self::cd_hunk_is_all_data_sectors(&hunk);
            trace!(
                raw = hunk.len(),
                has_flac, has_non_flac, skip_flac, "chd cd hunk codec trial"
            );
            let needs_raw_sectors = has_flac && !skip_flac;
            let normalize_ecc = has_non_flac;
            let prepared = self.prepare_cd_hunk_streams(
                &hunk,
                needs_raw_sectors,
                normalize_ecc,
                &mut scratch.cd,
            )?;
            let mut shared_streams = CdSharedCompressedStreams::default();
            for (codec_slot, codec) in encodable_codecs {
                if skip_flac && *codec == ChdCodec::CD_FLAC {
                    continue;
                }
                let compressed = self.compress_prepared_cd_hunk(
                    *codec,
                    compression_level,
                    hunk.len(),
                    &prepared,
                    Some(&mut shared_streams),
                )?;
                if best
                    .as_ref()
                    .map(|(_, candidate)| compressed.len() < candidate.len())
                    .unwrap_or(true)
                {
                    best = Some((*codec_slot, compressed));
                }
            }
        } else {
            for (codec_slot, codec) in encodable_codecs {
                let compressed =
                    self.compress_rust_hunk(create_kind, *codec, compression_level, &hunk)?;
                if best
                    .as_ref()
                    .map(|(_, candidate)| compressed.len() < candidate.len())
                    .unwrap_or(true)
                {
                    best = Some((*codec_slot, compressed));
                }
            }
        }

        let raw_len = hunk.len();
        let best_packed = best.as_ref().map(|(slot, payload)| (*slot, payload.len()));
        let keep_compressed = best
            .as_ref()
            .map(|(_, compressed)| {
                self.prefer_compressed_payload(primary_codec, compressed.len(), raw_len)
            })
            .unwrap_or(false);
        trace!(
            raw = raw_len,
            best_slot = best_packed.map(|(slot, _)| slot),
            packed = best_packed.map(|(_, len)| len),
            keep_compressed,
            "chd hunk best codec selected"
        );
        Ok(best
            .filter(|(_, compressed)| {
                self.prefer_compressed_payload(primary_codec, compressed.len(), hunk.len())
            })
            .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk)))
    }

    pub(super) fn compress_rust_cd_hunk(
        &self,
        primary_codec: ChdCodec,
        compression_level: i32,
        hunk: &[u8],
    ) -> Result<Vec<u8>> {
        let mut scratch = ChdCompressionScratch::default();
        let prepared = self.prepare_cd_hunk_streams(
            hunk,
            primary_codec == ChdCodec::CD_FLAC,
            primary_codec != ChdCodec::CD_FLAC,
            &mut scratch.cd,
        )?;
        self.compress_prepared_cd_hunk(
            primary_codec,
            compression_level,
            hunk.len(),
            &prepared,
            None,
        )
    }

    pub(super) fn prepare_cd_hunk_streams<'a>(
        &self,
        hunk: &[u8],
        needs_raw_sectors: bool,
        normalize_ecc: bool,
        scratch: &'a mut CdHunkScratch,
    ) -> Result<PreparedCdHunk<'a>> {
        let frame_bytes = usize::try_from(Self::CD_FRAME_BYTES).map_err(|_| {
            RomWeaverError::Validation("invalid CD frame size for rust CHD encoder".to_string())
        })?;
        if frame_bytes != Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES {
            return Err(RomWeaverError::Validation(
                "unexpected CD frame layout for rust CHD encoder".to_string(),
            ));
        }
        if !hunk.len().is_multiple_of(frame_bytes) {
            return Err(RomWeaverError::Validation(
                "cd hunk size must be a multiple of frame size".to_string(),
            ));
        }

        let frame_count = hunk.len() / frame_bytes;
        let sector_bytes = frame_count * Self::CD_SECTOR_DATA_BYTES;
        let subcode_bytes = frame_count * Self::CD_SUBCODE_BYTES;
        let keep_separate_raw = needs_raw_sectors && normalize_ecc;

        scratch.sectors.clear();
        scratch.subcode.clear();
        scratch.raw_sectors.clear();
        scratch.ecc_bitmap.clear();
        if scratch.sectors.capacity() < sector_bytes {
            scratch
                .sectors
                .reserve(sector_bytes - scratch.sectors.capacity());
        }
        if scratch.subcode.capacity() < subcode_bytes {
            scratch
                .subcode
                .reserve(subcode_bytes - scratch.subcode.capacity());
        }
        if keep_separate_raw && scratch.raw_sectors.capacity() < sector_bytes {
            scratch
                .raw_sectors
                .reserve(sector_bytes - scratch.raw_sectors.capacity());
        }
        if normalize_ecc {
            scratch.ecc_bitmap.resize(frame_count.div_ceil(8), 0);
        }

        // CHD CD codecs can regenerate standard sync/ECC bytes when the hunk bitmap marks them.
        for (frame_index, frame) in hunk.chunks_exact(frame_bytes).enumerate() {
            let sector_start = scratch.sectors.len();
            if keep_separate_raw {
                scratch
                    .raw_sectors
                    .extend_from_slice(&frame[..Self::CD_SECTOR_DATA_BYTES]);
            }
            scratch
                .sectors
                .extend_from_slice(&frame[..Self::CD_SECTOR_DATA_BYTES]);
            if normalize_ecc {
                let sector =
                    &mut scratch.sectors[sector_start..sector_start + Self::CD_SECTOR_DATA_BYTES];
                if Self::cd_sector_has_reconstructable_ecc(sector) {
                    scratch.ecc_bitmap[frame_index / 8] |= 1_u8 << (frame_index % 8);
                    Self::cd_sector_clear_sync_and_ecc(sector);
                }
            }
            scratch.subcode.extend_from_slice(
                &frame[Self::CD_SECTOR_DATA_BYTES
                    ..Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES],
            );
        }

        Ok(PreparedCdHunk {
            frame_count,
            sectors: &scratch.sectors,
            raw_sectors: keep_separate_raw.then_some(scratch.raw_sectors.as_slice()),
            subcode: &scratch.subcode,
            ecc_bitmap: &scratch.ecc_bitmap,
        })
    }

    pub(super) fn compress_prepared_cd_hunk(
        &self,
        primary_codec: ChdCodec,
        compression_level: i32,
        hunk_len: usize,
        prepared: &PreparedCdHunk<'_>,
        shared_streams: Option<&mut CdSharedCompressedStreams>,
    ) -> Result<Vec<u8>> {
        trace!(
            codec = ?primary_codec,
            frames = prepared.frame_count,
            raw = hunk_len,
            level = compression_level,
            "chd cd hunk encode"
        );
        let sectors = prepared.sectors_for_codec(primary_codec);
        match primary_codec {
            ChdCodec::CD_ZSTD => self.compress_prepared_cd_zstd_payload(
                sectors,
                prepared,
                compression_level,
                hunk_len,
            ),
            ChdCodec::CD_ZLIB => self.compress_prepared_cd_zlib_payload(
                sectors,
                prepared,
                compression_level,
                hunk_len,
                shared_streams,
            ),
            ChdCodec::CD_LZMA => self.compress_prepared_cd_lzma_payload(
                sectors,
                prepared,
                compression_level,
                hunk_len,
                shared_streams,
            ),
            ChdCodec::CD_FLAC => {
                self.compress_prepared_cd_flac_payload(sectors, prepared, compression_level)
            }
            other => Err(RomWeaverError::Unsupported(
                UnsupportedOp::ChdCodecForMedia {
                    codec: self.codec_label(other).to_string(),
                    scope: ChdMediaScope::Disc,
                },
            )),
        }
    }

    pub(super) fn cd_payload_header(
        prepared: &PreparedCdHunk<'_>,
        hunk_len: usize,
        compressed_capacity_hint: usize,
    ) -> (Vec<u8>, usize, usize) {
        let ecc_bytes = prepared.frame_count.div_ceil(8);
        let comp_len_bytes = if hunk_len < 65_536 { 2 } else { 3 };
        let mut output = Vec::with_capacity(ecc_bytes + comp_len_bytes + compressed_capacity_hint);
        debug_assert_eq!(prepared.ecc_bitmap.len(), ecc_bytes);
        output.extend_from_slice(prepared.ecc_bitmap);
        output.resize(ecc_bytes + comp_len_bytes, 0);
        (output, ecc_bytes, comp_len_bytes)
    }

    pub(super) fn write_cd_sector_stream_len(
        output: &mut [u8],
        ecc_bytes: usize,
        comp_len_bytes: usize,
        sector_stream_len: usize,
    ) -> Result<()> {
        let sector_len_u32 = u32::try_from(sector_stream_len).map_err(|_| {
            RomWeaverError::Validation("cd sector stream size exceeded u32".to_string())
        })?;
        if comp_len_bytes == 2 {
            if sector_len_u32 > 0xFFFF {
                return Err(RomWeaverError::Validation(
                    "cd sector stream too large for short header length".to_string(),
                ));
            }
            output[ecc_bytes] = ((sector_len_u32 >> 8) & 0xFF) as u8;
            output[ecc_bytes + 1] = (sector_len_u32 & 0xFF) as u8;
        } else {
            if sector_len_u32 > 0x00FF_FFFF {
                return Err(RomWeaverError::Validation(
                    "cd sector stream too large for extended header length".to_string(),
                ));
            }
            output[ecc_bytes] = ((sector_len_u32 >> 16) & 0xFF) as u8;
            output[ecc_bytes + 1] = ((sector_len_u32 >> 8) & 0xFF) as u8;
            output[ecc_bytes + 2] = (sector_len_u32 & 0xFF) as u8;
        }
        Ok(())
    }

    pub(super) fn deflate_append(
        output: Vec<u8>,
        input: &[u8],
        compression: GzipCompression,
        label: &str,
    ) -> Result<Vec<u8>> {
        let mut encoder = DeflateEncoder::new(output, compression);
        encoder.write_all(input).map_err(|error| {
            RomWeaverError::Validation(format!("{label} compression failed: {error}"))
        })?;
        encoder.finish().map_err(|error| {
            RomWeaverError::Validation(format!("{label} compression failed: {error}"))
        })
    }

    pub(super) fn deflate_bytes(
        input: &[u8],
        compression: GzipCompression,
        label: &str,
    ) -> Result<Vec<u8>> {
        Self::deflate_append(Vec::new(), input, compression, label)
    }

    pub(super) fn append_default_cd_subcode_deflate(
        mut output: Vec<u8>,
        prepared: &PreparedCdHunk<'_>,
        compression_level: i32,
        shared_streams: Option<&mut CdSharedCompressedStreams>,
    ) -> Result<Vec<u8>> {
        let compression = Self::chd_cd_subcode_compression(compression_level);
        if let Some(shared_streams) = shared_streams {
            if shared_streams.deflate_subcode_default.is_none() {
                shared_streams.deflate_subcode_default = Some(Self::deflate_bytes(
                    prepared.subcode,
                    compression,
                    "cd subcode zlib",
                )?);
            }
            if let Some(subcode_stream) = &shared_streams.deflate_subcode_default {
                output.extend_from_slice(subcode_stream);
                return Ok(output);
            }
        }
        Self::deflate_append(output, prepared.subcode, compression, "cd subcode zlib")
    }

    pub(super) fn zstd_append(
        mut output: Vec<u8>,
        input: &[u8],
        compression_level: i32,
        label: &str,
    ) -> Result<Vec<u8>> {
        // One-shot (bulk) compression pledges the source size so zstd shrinks the window log and
        // match tables to fit this hunk. A streaming encoder leaves the window at the level's
        // default (windowLog 27 / ~128 MiB workspace at level 22), which - multiplied across the
        // create thread pool - overruns the wasm memory cap and trips a concurrent memory.grow
        // out-of-bounds in the browser. The compressed data is identical for a sub-window input;
        // only the frame header differs, and it stays a valid, chdman-decodable zstd frame. The
        // compressor is reused per worker thread so the level-22 workspace is allocated once
        // rather than per hunk.
        let compressed = CD_ZSTD_COMPRESSOR.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = Some(
                    zstd::bulk::Compressor::new(compression_level).map_err(|error| {
                        RomWeaverError::Validation(format!("{label} compression failed: {error}"))
                    })?,
                );
            }
            let compressor = slot.as_mut().expect("compressor initialized above");
            compressor
                .set_compression_level(compression_level)
                .map_err(|error| {
                    RomWeaverError::Validation(format!("{label} compression failed: {error}"))
                })?;
            compressor.compress(input).map_err(|error| {
                RomWeaverError::Validation(format!("{label} compression failed: {error}"))
            })
        })?;
        output.extend_from_slice(&compressed);
        Ok(output)
    }

    pub(super) fn chd_zlib_compression(compression_level: i32) -> GzipCompression {
        if compression_level <= 0 {
            GzipCompression::default()
        } else {
            GzipCompression::new(compression_level.clamp(1, 9) as u32)
        }
    }

    pub(super) fn chd_cd_subcode_compression(compression_level: i32) -> GzipCompression {
        if compression_level <= 0 {
            GzipCompression::best()
        } else {
            Self::chd_zlib_compression(compression_level)
        }
    }

    pub(super) fn compress_prepared_cd_zstd_payload(
        &self,
        sectors: &[u8],
        prepared: &PreparedCdHunk<'_>,
        compression_level: i32,
        hunk_len: usize,
    ) -> Result<Vec<u8>> {
        let (mut output, ecc_bytes, comp_len_bytes) =
            Self::cd_payload_header(prepared, hunk_len, sectors.len() / 4);
        let sector_start = output.len();
        output = Self::zstd_append(output, sectors, compression_level, "cd zstd")?;
        let sector_stream_len = output.len().saturating_sub(sector_start);
        Self::write_cd_sector_stream_len(
            &mut output,
            ecc_bytes,
            comp_len_bytes,
            sector_stream_len,
        )?;
        Self::zstd_append(
            output,
            prepared.subcode,
            compression_level,
            "cd subcode zstd",
        )
    }

    pub(super) fn compress_prepared_cd_zlib_payload(
        &self,
        sectors: &[u8],
        prepared: &PreparedCdHunk<'_>,
        compression_level: i32,
        hunk_len: usize,
        shared_streams: Option<&mut CdSharedCompressedStreams>,
    ) -> Result<Vec<u8>> {
        let (mut output, ecc_bytes, comp_len_bytes) =
            Self::cd_payload_header(prepared, hunk_len, sectors.len() / 4);
        let sector_start = output.len();
        output = Self::deflate_append(
            output,
            sectors,
            Self::chd_zlib_compression(compression_level),
            "cd zlib",
        )?;
        let sector_stream_len = output.len().saturating_sub(sector_start);
        Self::write_cd_sector_stream_len(
            &mut output,
            ecc_bytes,
            comp_len_bytes,
            sector_stream_len,
        )?;
        Self::append_default_cd_subcode_deflate(output, prepared, compression_level, shared_streams)
    }

    pub(super) fn compress_prepared_cd_lzma_payload(
        &self,
        sectors: &[u8],
        prepared: &PreparedCdHunk<'_>,
        compression_level: i32,
        hunk_len: usize,
        shared_streams: Option<&mut CdSharedCompressedStreams>,
    ) -> Result<Vec<u8>> {
        let lzma_level = Self::resolved_chd_lzma_level(compression_level);

        let (mut output, ecc_bytes, comp_len_bytes) =
            Self::cd_payload_header(prepared, hunk_len, sectors.len() / 4);
        let sector_start = output.len();
        Self::append_lzma_raw_no_header_no_eopm(&mut output, sectors, lzma_level, "cd lzma")?;
        let sector_stream_len = output.len().saturating_sub(sector_start);
        Self::write_cd_sector_stream_len(
            &mut output,
            ecc_bytes,
            comp_len_bytes,
            sector_stream_len,
        )?;
        Self::append_default_cd_subcode_deflate(output, prepared, compression_level, shared_streams)
    }

    pub(super) fn compress_prepared_cd_flac_payload(
        &self,
        sectors: &[u8],
        prepared: &PreparedCdHunk<'_>,
        compression_level: i32,
    ) -> Result<Vec<u8>> {
        let sector_stream = self.encode_flac_frame_stream(
            sectors,
            FlacSampleByteOrder::BigEndian,
            compression_level,
        )?;
        // cdfl stores frame FLAC stream directly, followed by deflate-compressed subcode.
        let mut output = Vec::with_capacity(sector_stream.len() + prepared.subcode.len() / 2);
        output.extend_from_slice(&sector_stream);
        Self::deflate_append(
            output,
            prepared.subcode,
            Self::chd_cd_subcode_compression(compression_level),
            "cd subcode zlib",
        )
    }

    pub(super) fn resolved_chd_lzma_level(compression_level: i32) -> u32 {
        if compression_level <= 0 {
            9
        } else {
            compression_level as u32
        }
        .min(9)
    }

    pub(super) fn append_lzma_raw_no_header_no_eopm(
        output: &mut Vec<u8>,
        input: &[u8],
        level: u32,
        context: &str,
    ) -> Result<()> {
        let compressed = Self::compress_lzma_raw_no_header_no_eopm(input, level, context)?;
        output.extend_from_slice(&compressed);
        Ok(())
    }

    pub(super) fn compress_lzma_raw_no_header_no_eopm(
        input: &[u8],
        level: u32,
        context: &str,
    ) -> Result<Vec<u8>> {
        const LZMA_FILTER_LZMA1EXT: liblzma_sys::lzma_vli = 0x4000000000000002;

        // Match MAME/chdman's CHD LZMA configuration: raw LZMA1 with no header and no
        // end-of-stream marker (the CHD map records the decompressed size), lc=3/lp=0/pb=2,
        // and a hunk-bounded dictionary.
        let reduce_size = u32::try_from(input.len()).unwrap_or(u32::MAX);
        let mut options = unsafe { std::mem::zeroed::<liblzma_sys::lzma_options_lzma>() };
        let preset_status = unsafe { liblzma_sys::lzma_lzma_preset(&mut options, level.min(9)) };
        if preset_status != 0 {
            return Err(RomWeaverError::Validation(format!(
                "{context} compression init failed: invalid liblzma preset {level}"
            )));
        }
        options.lc = 3;
        options.lp = 0;
        options.pb = 2;
        options.dict_size = Self::chd_lzma_dict_size(level, reduce_size);
        options.ext_flags = 0;
        options.ext_size_low = input.len() as u32;
        options.ext_size_high = ((input.len() as u64) >> 32) as u32;

        let filters = [
            liblzma_sys::lzma_filter {
                id: LZMA_FILTER_LZMA1EXT,
                options: (&mut options as *mut liblzma_sys::lzma_options_lzma)
                    .cast::<std::ffi::c_void>(),
            },
            liblzma_sys::lzma_filter {
                id: liblzma_sys::LZMA_VLI_UNKNOWN,
                options: std::ptr::null_mut(),
            },
        ];

        let output_bound = unsafe { liblzma_sys::lzma_stream_buffer_bound(input.len()) };
        if output_bound == 0 {
            return Err(RomWeaverError::Validation(format!(
                "{context} compression failed: input too large for liblzma"
            )));
        }

        let mut output = vec![0u8; output_bound];
        let mut output_pos = 0usize;
        let status = unsafe {
            liblzma_sys::lzma_raw_buffer_encode(
                filters.as_ptr(),
                std::ptr::null(),
                input.as_ptr(),
                input.len(),
                output.as_mut_ptr(),
                &mut output_pos,
                output.len(),
            )
        };
        if status != liblzma_sys::LZMA_OK {
            return Err(RomWeaverError::Validation(format!(
                "{context} compression failed: {}",
                Self::lzma_status_name(status)
            )));
        }

        output.truncate(output_pos);
        Ok(output)
    }

    pub(super) fn chd_lzma_dict_size(level: u32, reduce_size: u32) -> u32 {
        let mut dict_size = if level <= 5 {
            1 << (level * 2 + 14)
        } else if level <= 7 {
            1 << 25
        } else {
            1 << 26
        };

        if dict_size > reduce_size {
            for i in 11..=30 {
                if reduce_size <= (2_u32 << i) {
                    dict_size = 2_u32 << i;
                    break;
                }
                if reduce_size <= (3_u32 << i) {
                    dict_size = 3_u32 << i;
                    break;
                }
            }
        }
        dict_size
    }

    pub(super) fn lzma_status_name(status: liblzma_sys::lzma_ret) -> &'static str {
        match status {
            value if value == liblzma_sys::LZMA_OK => "ok",
            value if value == liblzma_sys::LZMA_STREAM_END => "stream end",
            value if value == liblzma_sys::LZMA_MEM_ERROR => "memory allocation failed",
            value if value == liblzma_sys::LZMA_MEMLIMIT_ERROR => "memory limit reached",
            value if value == liblzma_sys::LZMA_FORMAT_ERROR => "format error",
            value if value == liblzma_sys::LZMA_OPTIONS_ERROR => "unsupported options",
            value if value == liblzma_sys::LZMA_DATA_ERROR => "input data error",
            value if value == liblzma_sys::LZMA_BUF_ERROR => "output buffer too small",
            value if value == liblzma_sys::LZMA_PROG_ERROR => "programming error",
            _ => "unknown error",
        }
    }
}
