use super::*;

impl ChdContainerHandler {
    pub(super) fn pcm_i16_interleaved_to_samples(
        &self,
        pcm_bytes: &[u8],
        byte_order: FlacSampleByteOrder,
    ) -> Result<Vec<i32>> {
        if !pcm_bytes.len().is_multiple_of(Self::FLAC_CHANNELS * 2) {
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

    pub(super) fn encode_flac_frame_stream(
        &self,
        pcm_bytes: &[u8],
        byte_order: FlacSampleByteOrder,
        compression_level: i32,
    ) -> Result<Vec<u8>> {
        let samples = self.pcm_i16_interleaved_to_samples(pcm_bytes, byte_order)?;
        let samples_per_channel = samples.len() / Self::FLAC_CHANNELS;
        if samples_per_channel < 32 {
            return Err(RomWeaverError::Validation(format!(
                "flac encode requires at least 32 samples per channel; received {samples_per_channel}"
            )));
        }
        let block_size = samples_per_channel.min(32_767);
        let config = self
            .build_flac_encoder_config(compression_level)
            .into_verified()
            .map_err(|error| {
                RomWeaverError::Validation(format!("invalid flac encoder configuration: {error:?}"))
            })?;
        let source = flacenc::source::MemSource::from_samples(
            &samples,
            Self::FLAC_CHANNELS,
            Self::FLAC_BITS_PER_SAMPLE,
            Self::FLAC_SAMPLE_RATE_HZ,
        );
        let stream = flacenc::encode_with_fixed_block_size(&config, source, block_size).map_err(
            |error| RomWeaverError::Validation(format!("flac compression failed: {error}")),
        )?;
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

    pub(super) fn build_flac_encoder_config(
        &self,
        compression_level: i32,
    ) -> flacenc::config::Encoder {
        let mut config = flacenc::config::Encoder::default();
        if compression_level <= 0 {
            return config;
        }

        let level = compression_level.clamp(Self::FLAC_LEVEL_MIN, Self::FLAC_LEVEL_MAX);
        let (use_midside, use_lpc, fixed_max_order, lpc_order, prc_max_parameter, partitions) =
            match level {
                1 => (false, false, 1, 6, 9, 8),
                2 => (true, false, 2, 8, 10, 12),
                3 => (true, true, 3, 8, 11, 16),
                4 => (true, true, 4, 10, 12, 24),
                5 => (true, true, 4, 10, 13, 32),
                6 => (true, true, 4, 12, 14, 40),
                7 => (true, true, 4, 16, 14, 48),
                8 => (true, true, 4, 20, 14, 56),
                _ => (true, true, 4, 24, 14, 64),
            };

        config.stereo_coding.use_midside = use_midside;
        config.subframe_coding.use_lpc = use_lpc;
        config.subframe_coding.fixed.max_order = fixed_max_order;
        config.subframe_coding.fixed.order_sel =
            flacenc::config::OrderSel::ApproxEnt { partitions };
        config.subframe_coding.qlpc.lpc_order = lpc_order;
        config.subframe_coding.prc.max_parameter = prc_max_parameter;
        config
    }

    pub(super) fn encode_huffman_identity_payload(&self, hunk: &[u8]) -> Vec<u8> {
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

    pub(super) fn canonical_codes_from_lengths(
        &self,
        lengths: &[u8],
    ) -> Result<Vec<Option<(u32, u8)>>> {
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
            if code_len != 1 && next_start.saturating_mul(2) != curr_start + histogram[code_len] {
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

    pub(super) fn write_huffman_tree_rle_lengths(
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

    pub(super) fn encode_avhuff_video_payload(
        &self,
        width: u16,
        height: u16,
        video: &[u8],
    ) -> Result<Vec<u8>> {
        if width == 0 || height == 0 {
            return Ok(vec![0x80]);
        }
        if !width.is_multiple_of(2) {
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
                let (bits, bit_count) = delta_tree_codes[usize::from(dy0)].ok_or_else(|| {
                    RomWeaverError::Validation("missing avhuff delta code".to_string())
                })?;
                writer.write_bits(u64::from(bits), bit_count);

                let dcb = cb.wrapping_sub(prev_cb);
                prev_cb = cb;
                let (bits, bit_count) = delta_tree_codes[usize::from(dcb)].ok_or_else(|| {
                    RomWeaverError::Validation("missing avhuff delta code".to_string())
                })?;
                writer.write_bits(u64::from(bits), bit_count);

                let dy1 = y1.wrapping_sub(prev_y);
                prev_y = y1;
                let (bits, bit_count) = delta_tree_codes[usize::from(dy1)].ok_or_else(|| {
                    RomWeaverError::Validation("missing avhuff delta code".to_string())
                })?;
                writer.write_bits(u64::from(bits), bit_count);

                let dcr = cr.wrapping_sub(prev_cr);
                prev_cr = cr;
                let (bits, bit_count) = delta_tree_codes[usize::from(dcr)].ok_or_else(|| {
                    RomWeaverError::Validation("missing avhuff delta code".to_string())
                })?;
                writer.write_bits(u64::from(bits), bit_count);
            }
        }
        writer.align_to_byte();
        Ok(writer.finish())
    }

    pub(super) fn encode_avhuff_chav_hunk(&self, hunk: &[u8]) -> Result<Vec<u8>> {
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
                UnsupportedOp::ChdAvhuffSampleLimit {
                    max_samples_per_channel: 32767,
                },
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
}
