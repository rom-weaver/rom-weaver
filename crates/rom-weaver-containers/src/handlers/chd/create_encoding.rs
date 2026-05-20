    impl ChdContainerHandler {
        fn build_chd_v5_header(
            &self,
            logical_bytes: u64,
            map_offset: u64,
            hunk_bytes: u32,
            unit_bytes: u32,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            parent_sha1: Option<[u8; Self::CHD_SHA1_BYTES]>,
        ) -> [u8; Self::CHD_V5_HEADER_BYTES as usize] {
            let mut header = [0_u8; Self::CHD_V5_HEADER_BYTES as usize];
            header[0..8].copy_from_slice(&CHD_SIGNATURE);
            header[8..12].copy_from_slice(&(Self::CHD_V5_HEADER_BYTES as u32).to_be_bytes());
            header[12..16].copy_from_slice(&5_u32.to_be_bytes());
            header[16..20].copy_from_slice(&codecs[0].raw().to_be_bytes());
            header[20..24].copy_from_slice(&codecs[1].raw().to_be_bytes());
            header[24..28].copy_from_slice(&codecs[2].raw().to_be_bytes());
            header[28..32].copy_from_slice(&codecs[3].raw().to_be_bytes());
            header[32..40].copy_from_slice(&logical_bytes.to_be_bytes());
            header[40..48].copy_from_slice(&map_offset.to_be_bytes());
            header[48..56].copy_from_slice(&0_u64.to_be_bytes());
            header[56..60].copy_from_slice(&hunk_bytes.to_be_bytes());
            header[60..64].copy_from_slice(&unit_bytes.to_be_bytes());
            if let Some(parent_sha1) = parent_sha1 {
                header[Self::CHD_V5_HEADER_PARENT_SHA1_OFFSET as usize
                    ..Self::CHD_V5_HEADER_PARENT_SHA1_OFFSET as usize + Self::CHD_SHA1_BYTES]
                    .copy_from_slice(&parent_sha1);
            }
            header
        }

        fn pcm_i16_interleaved_to_samples(
            &self,
            pcm_bytes: &[u8],
            byte_order: FlacSampleByteOrder,
        ) -> Result<Vec<i32>> {
            if pcm_bytes.len() % (Self::FLAC_CHANNELS * 2) != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "flac encode expects stereo 16-bit interleaved PCM bytes (len={} is not divisible by {})",
                    pcm_bytes.len(),
                    Self::FLAC_CHANNELS * 2
                )));
            }
            let mut samples = Vec::with_capacity(pcm_bytes.len() / 2);
            for chunk in pcm_bytes.chunks_exact(2) {
                let value = match byte_order {
                    FlacSampleByteOrder::LittleEndian => i16::from_le_bytes([chunk[0], chunk[1]]),
                    FlacSampleByteOrder::BigEndian => i16::from_be_bytes([chunk[0], chunk[1]]),
                };
                samples.push(i32::from(value));
            }
            Ok(samples)
        }

        fn encode_flac_frame_stream(
            &self,
            pcm_bytes: &[u8],
            byte_order: FlacSampleByteOrder,
        ) -> Result<Vec<u8>> {
            let samples = self.pcm_i16_interleaved_to_samples(pcm_bytes, byte_order)?;
            let samples_per_channel = samples.len() / Self::FLAC_CHANNELS;
            if samples_per_channel < 32 {
                return Err(RomWeaverError::Validation(format!(
                    "flac encode requires at least 32 samples per channel; received {samples_per_channel}"
                )));
            }
            let block_size = samples_per_channel.min(32_767);
            let config = flacenc::config::Encoder::default()
                .into_verified()
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "invalid flac encoder configuration: {error:?}"
                    ))
                })?;
            let source = flacenc::source::MemSource::from_samples(
                &samples,
                Self::FLAC_CHANNELS,
                Self::FLAC_BITS_PER_SAMPLE,
                Self::FLAC_SAMPLE_RATE_HZ,
            );
            let stream = flacenc::encode_with_fixed_block_size(&config, source, block_size)
                .map_err(|error| {
                    RomWeaverError::Validation(format!("flac compression failed: {error}"))
                })?;
            let mut sink = flacenc::bitsink::ByteSink::new();
            for frame_index in 0..stream.frame_count() {
                let frame = stream.frame(frame_index).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "missing flac frame {frame_index} during serialization"
                    ))
                })?;
                frame.write(&mut sink).map_err(|error| {
                    RomWeaverError::Validation(format!("flac frame serialization failed: {error}"))
                })?;
            }
            Ok(sink.as_slice().to_vec())
        }

        fn encode_huffman_identity_payload(&self, hunk: &[u8]) -> Vec<u8> {
            let mut writer = MsbBitWriter::new();
            for length_bits in Self::HUFFMAN_SMALL_TREE_BITS {
                writer.write_bits(u64::from(length_bits), 3);
            }
            // The main tree uses 8-bit canonical lengths for all 256 symbols:
            // token stream: [9, 0] where 0 repeats the previous length 255 times.
            writer.write_bits(1, 1);
            writer.write_bits(0, 1);
            writer.write_bits(7, 3);
            writer.write_bits(246, 8);
            for &byte in hunk {
                writer.write_bits(u64::from(byte), 8);
            }
            writer.finish()
        }

        fn canonical_codes_from_lengths(&self, lengths: &[u8]) -> Result<Vec<Option<(u32, u8)>>> {
            let mut histogram = [0_u32; 33];
            for &length in lengths {
                if usize::from(length) >= histogram.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported huffman bit length {}",
                        length
                    )));
                }
                histogram[length as usize] = histogram[length as usize].saturating_add(1);
            }

            let mut curr_start = 0_u32;
            for code_len in (1..histogram.len()).rev() {
                let next_start = (curr_start + histogram[code_len]) >> 1;
                if code_len != 1 && next_start.saturating_mul(2) != curr_start + histogram[code_len]
                {
                    return Err(RomWeaverError::Validation(
                        "invalid huffman length distribution".to_string(),
                    ));
                }
                histogram[code_len] = curr_start;
                curr_start = next_start;
            }

            let mut codes = vec![None; lengths.len()];
            for (index, &length) in lengths.iter().enumerate() {
                if length == 0 {
                    continue;
                }
                let start = &mut histogram[length as usize];
                codes[index] = Some((*start, length));
                *start = start.saturating_add(1);
            }
            Ok(codes)
        }

        fn write_huffman_tree_rle_lengths(
            &self,
            writer: &mut MsbBitWriter,
            lengths: &[u8],
            rle_bits: u8,
        ) -> Result<()> {
            if rle_bits == 0 || rle_bits > 8 {
                return Err(RomWeaverError::Validation(
                    "invalid avhuff tree configuration".to_string(),
                ));
            }
            let max_symbol_value = (1_u16 << rle_bits) - 1;
            let max_run_len = usize::from(max_symbol_value).saturating_add(3);

            let mut index = 0usize;
            while index < lengths.len() {
                let value = lengths[index];
                if u16::from(value) > max_symbol_value {
                    return Err(RomWeaverError::Validation(format!(
                        "avhuff tree symbol `{value}` exceeds {rle_bits}-bit range"
                    )));
                }

                let mut run_len = 1usize;
                while index + run_len < lengths.len() && lengths[index + run_len] == value {
                    run_len += 1;
                }

                if value != 1 && run_len >= 3 {
                    let mut remaining = run_len;
                    while remaining >= 3 {
                        let this_run = remaining.min(max_run_len);
                        if this_run < 3 {
                            break;
                        }
                        writer.write_bits(1, rle_bits);
                        writer.write_bits(u64::from(value), rle_bits);
                        writer.write_bits(u64::try_from(this_run - 3).unwrap_or(0), rle_bits);
                        remaining -= this_run;
                    }
                    for _ in 0..remaining {
                        writer.write_bits(u64::from(value), rle_bits);
                    }
                } else if value == 1 {
                    for _ in 0..run_len {
                        writer.write_bits(1, rle_bits);
                        writer.write_bits(1, rle_bits);
                    }
                } else {
                    for _ in 0..run_len {
                        writer.write_bits(u64::from(value), rle_bits);
                    }
                }

                index += run_len;
            }
            Ok(())
        }

        fn encode_avhuff_video_payload(
            &self,
            width: u16,
            height: u16,
            video: &[u8],
        ) -> Result<Vec<u8>> {
            if width == 0 || height == 0 {
                return Ok(vec![0x80]);
            }
            if width % 2 != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "avhuff encode expects even frame width; received {width}"
                )));
            }

            let expected_video_bytes = usize::from(width)
                .saturating_mul(usize::from(height))
                .saturating_mul(2);
            if video.len() != expected_video_bytes {
                return Err(RomWeaverError::Validation(format!(
                    "avhuff frame video payload length mismatch (expected {expected_video_bytes}, found {})",
                    video.len()
                )));
            }

            let mut delta_tree_lengths = vec![9_u8; Self::AVHUFF_DELTA_TREE_SYMBOLS];
            for length in delta_tree_lengths
                .iter_mut()
                .take(Self::AVHUFF_DELTA_TREE_8BIT_COUNT)
            {
                *length = 8;
            }
            let delta_tree_codes = self.canonical_codes_from_lengths(&delta_tree_lengths)?;

            let mut writer = MsbBitWriter::new();
            writer.write_bits(0x80, 8);
            for _ in 0..3 {
                self.write_huffman_tree_rle_lengths(
                    &mut writer,
                    &delta_tree_lengths,
                    Self::AVHUFF_DELTA_TREE_BITS,
                )?;
                writer.align_to_byte();
            }

            let mut prev_y = 0_u8;
            let mut prev_cb = 0_u8;
            let mut prev_cr = 0_u8;
            let stride = usize::from(width) * 2;
            for row in 0..usize::from(height) {
                let row_start = row.saturating_mul(stride);
                let row_bytes = &video[row_start..row_start + stride];
                for pair in row_bytes.chunks_exact(4) {
                    let y0 = pair[0];
                    let cb = pair[1];
                    let y1 = pair[2];
                    let cr = pair[3];

                    let dy0 = y0.wrapping_sub(prev_y);
                    prev_y = y0;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dy0)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);

                    let dcb = cb.wrapping_sub(prev_cb);
                    prev_cb = cb;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dcb)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);

                    let dy1 = y1.wrapping_sub(prev_y);
                    prev_y = y1;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dy1)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);

                    let dcr = cr.wrapping_sub(prev_cr);
                    prev_cr = cr;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dcr)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);
                }
            }
            writer.align_to_byte();
            Ok(writer.finish())
        }

        fn encode_avhuff_chav_hunk(&self, hunk: &[u8]) -> Result<Vec<u8>> {
            if hunk.len() < 12 || &hunk[..4] != b"chav" {
                return Err(RomWeaverError::Validation(
                    "avhuff encode expects a raw `chav` frame payload".to_string(),
                ));
            }

            let metadata_size = usize::from(hunk[4]);
            let channels = usize::from(hunk[5]);
            let samples = usize::from(u16::from_be_bytes([hunk[6], hunk[7]]));
            let width = u16::from_be_bytes([hunk[8], hunk[9]]);
            let height = u16::from_be_bytes([hunk[10], hunk[11]]);

            let audio_bytes = channels.saturating_mul(samples).saturating_mul(2);
            let video_bytes = usize::from(width)
                .saturating_mul(usize::from(height))
                .saturating_mul(2);
            let expected_len = 12usize
                .saturating_add(metadata_size)
                .saturating_add(audio_bytes)
                .saturating_add(video_bytes);
            if hunk.len() != expected_len {
                return Err(RomWeaverError::Validation(format!(
                    "avhuff encode expected {expected_len} bytes from chav frame header, found {}",
                    hunk.len()
                )));
            }

            if samples.saturating_mul(2) > usize::from(u16::MAX) {
                return Err(RomWeaverError::Unsupported(
                    "avhuff encode currently supports up to 32767 audio samples per channel"
                        .to_string(),
                ));
            }

            let metadata_start = 12;
            let metadata_end = metadata_start + metadata_size;
            let audio_end = metadata_end + audio_bytes;
            let metadata = &hunk[metadata_start..metadata_end];
            let audio = &hunk[metadata_end..audio_end];
            let video = &hunk[audio_end..];

            let mut encoded_audio = Vec::with_capacity(audio_bytes);
            let channel_bytes = samples.saturating_mul(2);
            for channel_index in 0..channels {
                let channel_start = channel_index.saturating_mul(channel_bytes);
                let channel_end = channel_start + channel_bytes;
                let channel_samples = &audio[channel_start..channel_end];
                let mut prev_sample = 0_u16;
                for sample_bytes in channel_samples.chunks_exact(2) {
                    let sample = u16::from_be_bytes([sample_bytes[0], sample_bytes[1]]);
                    let delta = sample.wrapping_sub(prev_sample);
                    prev_sample = sample;
                    encoded_audio.extend_from_slice(&delta.to_be_bytes());
                }
            }
            let encoded_video = self.encode_avhuff_video_payload(width, height, video)?;

            let mut encoded = Vec::with_capacity(
                10usize
                    .saturating_add(channels.saturating_mul(2))
                    .saturating_add(metadata_size)
                    .saturating_add(encoded_audio.len())
                    .saturating_add(encoded_video.len()),
            );
            encoded.push(hunk[4]);
            encoded.push(hunk[5]);
            encoded.extend_from_slice(&hunk[6..8]);
            encoded.extend_from_slice(&hunk[8..10]);
            encoded.extend_from_slice(&hunk[10..12]);
            // Tree size of 0 indicates uncompressed audio deltas.
            encoded.extend_from_slice(&0_u16.to_be_bytes());
            for _ in 0..channels {
                encoded.extend_from_slice(
                    &u16::try_from(channel_bytes)
                        .map_err(|_| {
                            RomWeaverError::Validation(
                                "avhuff channel payload length overflow".to_string(),
                            )
                        })?
                        .to_be_bytes(),
                );
            }
            encoded.extend_from_slice(metadata);
            encoded.extend_from_slice(&encoded_audio);
            encoded.extend_from_slice(&encoded_video);
            Ok(encoded)
        }

        fn compress_rust_hunk(
            &self,
            create_kind: &ChdCreateKind,
            primary_codec: ChdCodec,
            compression_level: i32,
            hunk: &[u8],
        ) -> Result<Vec<u8>> {
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
                    let lzma_level = if compression_level <= 0 {
                        9
                    } else {
                        compression_level as u32
                    }
                    .min(9);
                    let mut options = LzmaOptions::with_preset(lzma_level);
                    options.lc = 3;
                    options.lp = 0;
                    options.pb = 2;
                    options.dict_size = Self::chd_lzma_dict_size(lzma_level, hunk.len() as u32);
                    let mut compressed = Vec::new();
                    let mut writer = LzmaWriter::new_no_header(&mut compressed, &options, false)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                        })?;
                    writer.write_all(hunk).map_err(|error| {
                        RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                    })?;
                    writer.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                    })?;
                    Ok(compressed)
                }
                ChdCodec::HUFFMAN => Ok(self.encode_huffman_identity_payload(hunk)),
                ChdCodec::AVHUFF => match create_kind {
                    ChdCreateKind::Av(_) => self.encode_avhuff_chav_hunk(hunk),
                    _ => Err(RomWeaverError::Unsupported(
                        "rust chd compressed create supports `avhuff` only for `chav` frame inputs"
                            .to_string(),
                    )),
                },
                ChdCodec::FLAC => {
                    let mut encoded = Vec::new();
                    encoded.push(b'L');
                    encoded.extend(
                        self.encode_flac_frame_stream(hunk, FlacSampleByteOrder::LittleEndian)?,
                    );
                    Ok(encoded)
                }
                other => Err(RomWeaverError::Unsupported(format!(
                    "rust chd compressed create does not support codec `{}` for this media mode",
                    self.codec_label(other)
                ))),
            }
        }

        fn compress_rust_cd_hunk(
            &self,
            primary_codec: ChdCodec,
            compression_level: i32,
            hunk: &[u8],
        ) -> Result<Vec<u8>> {
            let frame_bytes = usize::try_from(Self::CD_FRAME_BYTES).map_err(|_| {
                RomWeaverError::Validation("invalid CD frame size for rust CHD encoder".to_string())
            })?;
            if frame_bytes != Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES {
                return Err(RomWeaverError::Validation(
                    "unexpected CD frame layout for rust CHD encoder".to_string(),
                ));
            }
            if hunk.len() % frame_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "cd hunk size must be a multiple of frame size".to_string(),
                ));
            }

            let frame_count = hunk.len() / frame_bytes;
            let mut sectors = Vec::with_capacity(frame_count * Self::CD_SECTOR_DATA_BYTES);
            let mut subcode = Vec::with_capacity(frame_count * Self::CD_SUBCODE_BYTES);
            for frame in hunk.chunks_exact(frame_bytes) {
                sectors.extend_from_slice(&frame[..Self::CD_SECTOR_DATA_BYTES]);
                subcode.extend_from_slice(
                    &frame[Self::CD_SECTOR_DATA_BYTES
                        ..Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES],
                );
            }

            let sector_stream = match primary_codec {
                ChdCodec::CD_ZSTD => {
                    zstd_compress(&sectors, compression_level).map_err(|error| {
                        RomWeaverError::Validation(format!("cd zstd compression failed: {error}"))
                    })?
                }
                ChdCodec::CD_ZLIB => {
                    let compression = if compression_level <= 0 {
                        GzipCompression::default()
                    } else {
                        GzipCompression::new(compression_level.clamp(1, 9) as u32)
                    };
                    let mut encoder = DeflateEncoder::new(Vec::new(), compression);
                    encoder.write_all(&sectors).map_err(|error| {
                        RomWeaverError::Validation(format!("cd zlib compression failed: {error}"))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("cd zlib compression failed: {error}"))
                    })?
                }
                ChdCodec::CD_LZMA => {
                    let lzma_level = if compression_level <= 0 {
                        9
                    } else {
                        compression_level as u32
                    }
                    .min(9);
                    let mut options = LzmaOptions::with_preset(lzma_level);
                    options.lc = 3;
                    options.lp = 0;
                    options.pb = 2;
                    options.dict_size = Self::chd_lzma_dict_size(lzma_level, sectors.len() as u32);
                    let mut compressed = Vec::new();
                    let mut writer = LzmaWriter::new_no_header(&mut compressed, &options, false)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "cd lzma compression failed: {error}"
                            ))
                        })?;
                    writer.write_all(&sectors).map_err(|error| {
                        RomWeaverError::Validation(format!("cd lzma compression failed: {error}"))
                    })?;
                    writer.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("cd lzma compression failed: {error}"))
                    })?;
                    compressed
                }
                ChdCodec::CD_FLAC => {
                    self.encode_flac_frame_stream(&sectors, FlacSampleByteOrder::BigEndian)?
                }
                other => {
                    return Err(RomWeaverError::Unsupported(format!(
                        "rust chd compressed create does not support codec `{}` for disc media",
                        self.codec_label(other)
                    )));
                }
            };

            let subcode_stream = match primary_codec {
                ChdCodec::CD_ZSTD => {
                    zstd_compress(&subcode, compression_level).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zstd compression failed: {error}"
                        ))
                    })?
                }
                ChdCodec::CD_ZLIB | ChdCodec::CD_LZMA | ChdCodec::CD_FLAC => {
                    let mut encoder = DeflateEncoder::new(Vec::new(), GzipCompression::default());
                    encoder.write_all(&subcode).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zlib compression failed: {error}"
                        ))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zlib compression failed: {error}"
                        ))
                    })?
                }
                _ => Vec::new(),
            };

            if primary_codec == ChdCodec::CD_FLAC {
                // cdfl stores frame FLAC stream directly, followed by deflate-compressed subcode.
                let mut output = Vec::with_capacity(sector_stream.len() + subcode_stream.len());
                output.extend_from_slice(&sector_stream);
                output.extend_from_slice(&subcode_stream);
                return Ok(output);
            }

            let sector_len_u32 = u32::try_from(sector_stream.len()).map_err(|_| {
                RomWeaverError::Validation("cd sector stream size exceeded u32".to_string())
            })?;
            let ecc_bytes = frame_count.div_ceil(8);
            let comp_len_bytes = if hunk.len() < 65_536 { 2 } else { 3 };
            let mut output = Vec::with_capacity(
                ecc_bytes + comp_len_bytes + sector_stream.len() + subcode_stream.len(),
            );
            output.resize(ecc_bytes + comp_len_bytes, 0);
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
            output.extend_from_slice(&sector_stream);
            output.extend_from_slice(&subcode_stream);
            Ok(output)
        }

        fn chd_lzma_dict_size(level: u32, reduce_size: u32) -> u32 {
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

        fn encode_v5_compressed_map(
            entries: &[RustCompressedHunkEntry],
        ) -> Result<(Vec<u8>, u16, u8, u8, u8, u64)> {
            let mut raw_map = vec![0_u8; entries.len().saturating_mul(12)];
            for (index, entry) in entries.iter().enumerate() {
                let offset = index.saturating_mul(12);
                raw_map[offset] = entry.compression_type;
                Self::write_u24_be(&mut raw_map[offset + 1..offset + 4], entry.length)?;
                Self::write_u48_be(&mut raw_map[offset + 4..offset + 10], entry.offset)?;
                raw_map[offset + 10..offset + 12].copy_from_slice(&entry.crc16.to_be_bytes());
            }
            let map_crc = Self::crc16_ibm3740(&raw_map);
            let length_bits = Self::bits_for_value(
                entries
                    .iter()
                    .map(|entry| entry.length)
                    .max()
                    .unwrap_or_default(),
            );
            let mut max_self = 0_u64;
            let mut max_parent = 0_u64;
            let mut first_offset = 0_u64;
            for entry in entries {
                match entry.compression_type {
                    0..=Self::CHD_V5_MAP_TYPE_UNCOMPRESSED => {
                        if first_offset == 0 {
                            first_offset = entry.offset;
                        }
                    }
                    Self::CHD_V5_MAP_TYPE_SELF => {
                        max_self = max_self.max(entry.offset);
                    }
                    Self::CHD_V5_MAP_TYPE_PARENT => {
                        max_parent = max_parent.max(entry.offset);
                    }
                    _ => {}
                }
            }
            let self_bits = if max_self == 0 {
                0
            } else {
                (u64::BITS - max_self.leading_zeros()) as u8
            };
            let parent_bits = if max_parent == 0 {
                0
            } else {
                (u64::BITS - max_parent.leading_zeros()) as u8
            };
            let max_compression_type = entries
                .iter()
                .map(|entry| entry.compression_type)
                .max()
                .unwrap_or(0);
            if max_compression_type > Self::CHD_V5_MAP_TYPE_MAX {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported compressed CHD map type {} for rust map encoder",
                    max_compression_type
                )));
            }
            let symbol_bit_lengths =
                Self::map_symbol_bit_lengths_for_max_type(max_compression_type)?;
            let symbol_codes = Self::canonical_huffman_codes(&symbol_bit_lengths)?;

            let mut bit_writer = MsbBitWriter::new();
            Self::write_map_symbol_tree_rle(&mut bit_writer, &symbol_bit_lengths)?;

            for entry in entries {
                let (bits, bit_count) = symbol_codes[usize::from(entry.compression_type)]
                    .ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "missing map huffman code for compression type {}",
                            entry.compression_type
                        ))
                    })?;
                bit_writer.write_bits(u64::from(bits), bit_count);
            }

            for entry in entries {
                match entry.compression_type {
                    0..=Self::CHD_V5_MAP_TYPE_COMPRESSED_MAX => {
                        bit_writer.write_bits(u64::from(entry.length), length_bits);
                        bit_writer.write_bits(u64::from(entry.crc16), 16);
                    }
                    Self::CHD_V5_MAP_TYPE_UNCOMPRESSED => {
                        bit_writer.write_bits(u64::from(entry.crc16), 16);
                    }
                    Self::CHD_V5_MAP_TYPE_SELF => {
                        bit_writer.write_bits(entry.offset, self_bits);
                    }
                    Self::CHD_V5_MAP_TYPE_PARENT => {
                        bit_writer.write_bits(entry.offset, parent_bits);
                    }
                    other => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported compressed CHD map type {} for rust map encoder",
                            other
                        )));
                    }
                }
            }
            Ok((
                bit_writer.finish(),
                map_crc,
                length_bits,
                self_bits,
                parent_bits,
                first_offset,
            ))
        }

        fn map_symbol_bit_lengths_for_max_type(max_type: u8) -> Result<[u8; 16]> {
            let mut lengths = [0_u8; 16];
            match max_type {
                0 => {
                    lengths[0] = 1;
                }
                1 => {
                    lengths[0] = 1;
                    lengths[1] = 1;
                }
                2 => {
                    lengths[0] = 1;
                    lengths[1] = 2;
                    lengths[2] = 2;
                }
                3 => {
                    lengths[0] = 2;
                    lengths[1] = 2;
                    lengths[2] = 2;
                    lengths[3] = 2;
                }
                4 => {
                    lengths[0] = 2;
                    lengths[1] = 2;
                    lengths[2] = 2;
                    lengths[3] = 3;
                    lengths[4] = 3;
                }
                5 | 6 => {
                    lengths[0..8].fill(3);
                }
                _ => {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported compressed CHD map type {max_type} for rust map encoder"
                    )));
                }
            }
            Ok(lengths)
        }

        fn canonical_huffman_codes(lengths: &[u8; 16]) -> Result<[Option<(u32, u8)>; 16]> {
            let mut histogram = [0_u32; 33];
            for &length in lengths {
                if usize::from(length) >= histogram.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported CHD map huffman bit length {}",
                        length
                    )));
                }
                histogram[length as usize] = histogram[length as usize].saturating_add(1);
            }

            let mut curr_start = 0_u32;
            for code_len in (1..histogram.len()).rev() {
                let next_start = (curr_start + histogram[code_len]) >> 1;
                if code_len != 1 && next_start.saturating_mul(2) != curr_start + histogram[code_len]
                {
                    return Err(RomWeaverError::Validation(
                        "invalid CHD map huffman length distribution".to_string(),
                    ));
                }
                histogram[code_len] = curr_start;
                curr_start = next_start;
            }

            let mut codes = [None; 16];
            for (index, &length) in lengths.iter().enumerate() {
                if length == 0 {
                    continue;
                }
                let start = &mut histogram[length as usize];
                codes[index] = Some((*start, length));
                *start = start.saturating_add(1);
            }
            Ok(codes)
        }

        fn write_map_symbol_tree_rle(
            bit_writer: &mut MsbBitWriter,
            lengths: &[u8; 16],
        ) -> Result<()> {
            let mut index = 0usize;
            while index < lengths.len() {
                let value = lengths[index];
                let mut run_len = 1usize;
                while index + run_len < lengths.len()
                    && lengths[index + run_len] == value
                    && run_len < 18
                {
                    run_len += 1;
                }

                if value != 1 && run_len >= 3 {
                    bit_writer.write_bits(1, 4);
                    bit_writer.write_bits(u64::from(value), 4);
                    bit_writer.write_bits(u64::try_from(run_len - 3).unwrap_or(0), 4);
                    index += run_len;
                    continue;
                }

                for _ in 0..run_len {
                    if value == 1 {
                        bit_writer.write_bits(1, 4);
                        bit_writer.write_bits(1, 4);
                    } else {
                        bit_writer.write_bits(u64::from(value), 4);
                    }
                }
                index += run_len;
            }
            Ok(())
        }

        fn write_u24_be(dst: &mut [u8], value: u32) -> Result<()> {
            if dst.len() < 3 {
                return Err(RomWeaverError::Validation(
                    "internal CHD map write buffer underflow".into(),
                ));
            }
            if value > 0x00FF_FFFF {
                return Err(RomWeaverError::Validation(format!(
                    "value {value} exceeds u24 range"
                )));
            }
            dst[0] = ((value >> 16) & 0xFF) as u8;
            dst[1] = ((value >> 8) & 0xFF) as u8;
            dst[2] = (value & 0xFF) as u8;
            Ok(())
        }

        fn write_u48_be(dst: &mut [u8], value: u64) -> Result<()> {
            if dst.len() < 6 {
                return Err(RomWeaverError::Validation(
                    "internal CHD map write buffer underflow".into(),
                ));
            }
            if value > 0x0000_FFFF_FFFF_FFFF {
                return Err(RomWeaverError::Validation(format!(
                    "value {value} exceeds u48 range"
                )));
            }
            dst[0] = ((value >> 40) & 0xFF) as u8;
            dst[1] = ((value >> 32) & 0xFF) as u8;
            dst[2] = ((value >> 24) & 0xFF) as u8;
            dst[3] = ((value >> 16) & 0xFF) as u8;
            dst[4] = ((value >> 8) & 0xFF) as u8;
            dst[5] = (value & 0xFF) as u8;
            Ok(())
        }

        fn bits_for_value(value: u32) -> u8 {
            if value == 0 {
                0
            } else {
                (u32::BITS - value.leading_zeros()) as u8
            }
        }

        fn crc16_ibm3740(bytes: &[u8]) -> u16 {
            let mut crc = 0xFFFFu16;
            for &byte in bytes {
                crc ^= u16::from(byte) << 8;
                for _ in 0..8 {
                    if (crc & 0x8000) != 0 {
                        crc = (crc << 1) ^ 0x1021;
                    } else {
                        crc <<= 1;
                    }
                }
            }
            crc
        }

        fn rust_metadata_entries(
            &self,
            create_kind: &ChdCreateKind,
        ) -> Result<Vec<RustMetadataEntry>> {
            match create_kind {
                ChdCreateKind::Raw => Ok(Vec::new()),
                ChdCreateKind::Dvd => Ok(vec![RustMetadataEntry {
                    tag: DVD_METADATA_TAG,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: vec![0],
                }]),
                ChdCreateKind::HardDisk(geometry) => {
                    let mut metadata = format!(
                        "CYLS:{},HEADS:{},SECS:{},BPS:{}",
                        geometry.cylinders,
                        geometry.heads,
                        geometry.sectors,
                        geometry.bytes_per_sector
                    )
                    .into_bytes();
                    metadata.push(0);
                    Ok(vec![RustMetadataEntry {
                        tag: HARD_DISK_METADATA_TAG,
                        flags: CHD_METADATA_FLAG_CHECKSUM,
                        data: metadata,
                    }])
                }
                ChdCreateKind::Disc(layout) => {
                    let mut entries = Vec::with_capacity(layout.tracks.len());
                    for track in &layout.tracks {
                        let pgtype = if track.pregap_has_data {
                            format!("V{}", track.mode.metadata_label())
                        } else {
                            track.mode.metadata_label().to_string()
                        };
                        let mut data = match layout.kind {
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
                        data.push(0);
                        entries.push(RustMetadataEntry {
                            tag: layout.kind.metadata_tag(),
                            flags: CHD_METADATA_FLAG_CHECKSUM,
                            data,
                        });
                    }
                    Ok(entries)
                }
                ChdCreateKind::Av(profile) => {
                    let mut metadata = format!(
                        "FPS:{}.{:06} WIDTH:{} HEIGHT:{} INTERLACED:{} CHANNELS:{} SAMPLERATE:{}",
                        profile.fps,
                        profile.fpsfrac,
                        profile.width,
                        profile.height,
                        profile.interlaced,
                        profile.channels,
                        profile.sample_rate
                    )
                    .into_bytes();
                    metadata.push(0);
                    Ok(vec![RustMetadataEntry {
                        tag: AV_METADATA_TAG,
                        flags: CHD_METADATA_FLAG_CHECKSUM,
                        data: metadata,
                    }])
                }
            }
        }

        fn append_rust_metadata(
            &self,
            output_file: &mut File,
            output_path: &Path,
            entries: &[RustMetadataEntry],
        ) -> Result<Option<u64>> {
            if entries.is_empty() {
                return Ok(None);
            }

            let mut entry_offsets = Vec::with_capacity(entries.len());
            for entry in entries {
                if entry.data.is_empty() || entry.data.len() >= 16 * 1024 * 1024 {
                    return Err(RomWeaverError::Validation(
                        "CHD metadata entries must be 1..16MiB".to_string(),
                    ));
                }
                let offset = output_file.stream_position().map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to determine metadata offset in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
                entry_offsets.push(offset);

                let mut header = [0_u8; 16];
                header[..4].copy_from_slice(&entry.tag.to_be_bytes());
                header[4] = entry.flags;
                Self::write_u24_be(
                    &mut header[5..8],
                    u32::try_from(entry.data.len()).map_err(|_| {
                        RomWeaverError::Validation("metadata length overflow".to_string())
                    })?,
                )?;
                output_file.write_all(&header).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD metadata header to `{}`: {error}",
                        output_path.display()
                    ))
                })?;
                output_file.write_all(&entry.data).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD metadata payload to `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            }

            for (index, offset) in entry_offsets.iter().enumerate() {
                let next = entry_offsets.get(index + 1).copied().unwrap_or(0);
                output_file
                    .seek(SeekFrom::Start(offset.saturating_add(8)))
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to seek CHD metadata link in `{}`: {error}",
                            output_path.display()
                        ))
                    })?;
                output_file
                    .write_all(&next.to_be_bytes())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to write CHD metadata link in `{}`: {error}",
                            output_path.display()
                        ))
                    })?;
            }
            let end = output_file.seek(SeekFrom::End(0)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to restore CHD output offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            let first = entry_offsets[0];
            if end < first {
                return Err(RomWeaverError::Validation(
                    "invalid CHD metadata layout".to_string(),
                ));
            }
            Ok(Some(first))
        }

        fn patch_chd_header_sha1s(
            &self,
            output_file: &mut File,
            output_path: &Path,
            source_path: &Path,
            logical_bytes: u64,
            metadata_entries: &[RustMetadataEntry],
        ) -> Result<()> {
            let raw_sha1 = Self::sha1_file_prefix(source_path, logical_bytes)?;
            let overall_sha1 = Self::compute_overall_sha1(&raw_sha1, metadata_entries);
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                Self::CHD_V5_HEADER_RAW_SHA1_OFFSET,
                &raw_sha1,
                "raw sha1",
            )?;
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                Self::CHD_V5_HEADER_SHA1_OFFSET,
                &overall_sha1,
                "sha1",
            )
        }

        fn compute_overall_sha1(
            raw_sha1: &[u8; Self::CHD_SHA1_BYTES],
            metadata_entries: &[RustMetadataEntry],
        ) -> [u8; Self::CHD_SHA1_BYTES] {
            let mut metadata_hashes = metadata_entries
                .iter()
                .filter(|entry| (entry.flags & CHD_METADATA_FLAG_CHECKSUM) != 0)
                .map(|entry| {
                    let mut hash_entry = [0_u8; 4 + Self::CHD_SHA1_BYTES];
                    hash_entry[..4].copy_from_slice(&entry.tag.to_be_bytes());
                    let digest = Sha1::digest(&entry.data);
                    hash_entry[4..].copy_from_slice(&digest);
                    hash_entry
                })
                .collect::<Vec<_>>();
            metadata_hashes.sort_unstable();

            let mut overall_sha1 = Sha1::new();
            overall_sha1.update(raw_sha1);
            for hash_entry in metadata_hashes {
                overall_sha1.update(hash_entry);
            }
            let digest = overall_sha1.finalize();
            let mut out = [0_u8; Self::CHD_SHA1_BYTES];
            out.copy_from_slice(&digest);
            out
        }

        fn sha1_file_prefix(
            source_path: &Path,
            logical_bytes: u64,
        ) -> Result<[u8; Self::CHD_SHA1_BYTES]> {
            let mut reader = BufReader::new(File::open(source_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open `{}` for CHD sha1: {error}",
                    source_path.display()
                ))
            })?);
            let mut sha1 = Sha1::new();
            let mut remaining = logical_bytes;
            let mut buffer = [0_u8; 64 * 1024];
            while remaining > 0 {
                let read_len =
                    usize::try_from(remaining.min(buffer.len() as u64)).map_err(|_| {
                        RomWeaverError::Validation("CHD sha1 read length overflow".to_string())
                    })?;
                reader
                    .read_exact(&mut buffer[..read_len])
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read `{}` for CHD sha1: {error}",
                            source_path.display()
                        ))
                    })?;
                sha1.update(&buffer[..read_len]);
                remaining = remaining.saturating_sub(read_len as u64);
            }

            let digest = sha1.finalize();
            let mut out = [0_u8; Self::CHD_SHA1_BYTES];
            out.copy_from_slice(&digest);
            Ok(out)
        }

        fn patch_chd_header_u64(
            &self,
            output_file: &mut File,
            output_path: &Path,
            header_offset: u64,
            value: u64,
            field_label: &str,
        ) -> Result<()> {
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                header_offset,
                &value.to_be_bytes(),
                field_label,
            )
        }

        fn patch_chd_header_bytes(
            &self,
            output_file: &mut File,
            output_path: &Path,
            header_offset: u64,
            bytes: &[u8],
            field_label: &str,
        ) -> Result<()> {
            let restore_offset = output_file.stream_position().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to capture CHD write offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            output_file
                .seek(SeekFrom::Start(header_offset))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to seek CHD {field_label} pointer in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            output_file.write_all(bytes).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to finalize CHD {field_label} pointer in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            output_file
                .seek(SeekFrom::Start(restore_offset))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to restore CHD write offset in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            Ok(())
        }

    }
