    const CD_SYNC_HEADER: [u8; 12] = [
        0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,
    ];
    const CD_SYNC_BYTES: usize = 12;
    const CD_MODE_OFFSET: usize = 0x0f;
    const CD_ECC_DATA_BYTES: usize = 0x8bc;
    const CD_ECC_P_OFFSET: usize = 0x81c;
    const CD_ECC_P_NUM_BYTES: usize = 86;
    const CD_ECC_P_COMPONENTS: usize = 24;
    const CD_ECC_Q_OFFSET: usize = CD_ECC_P_OFFSET + CD_ECC_P_NUM_BYTES * 2;
    const CD_ECC_Q_NUM_BYTES: usize = 52;
    const CD_ECC_Q_COMPONENTS: usize = 43;
    const CD_ECC_Q_STEP: usize = 88;
    const CD_ECC_LOW: [u8; 256] = build_cd_ecc_low_table();
    const CD_ECC_HIGH: [u8; 256] = build_cd_ecc_high_table();
    const CRC16_IBM3740_TABLE: [u16; 256] = build_crc16_ibm3740_table();
    const LZMA_FILTER_LZMA1EXT_NO_EOPM: lzma_sys::lzma_vli = 0x4000_0000_0000_0002;

    #[derive(Default)]
    struct ChdCompressionScratch {
        cd: CdHunkScratch,
    }

    #[derive(Default)]
    struct CdHunkScratch {
        sectors: Vec<u8>,
        raw_sectors: Vec<u8>,
        subcode: Vec<u8>,
        ecc_bitmap: Vec<u8>,
    }

    struct PreparedCdHunk<'a> {
        frame_count: usize,
        sectors: &'a [u8],
        raw_sectors: Option<&'a [u8]>,
        subcode: &'a [u8],
        ecc_bitmap: &'a [u8],
    }

    #[derive(Default)]
    struct CdSharedCompressedStreams {
        deflate_subcode_default: Option<Vec<u8>>,
    }

    impl<'a> PreparedCdHunk<'a> {
        fn sectors_for_codec(&self, codec: ChdCodec) -> &'a [u8] {
            if codec == ChdCodec::CD_FLAC {
                self.raw_sectors.unwrap_or(self.sectors)
            } else {
                self.sectors
            }
        }
    }

    const fn cd_ecc_low_value(value: u8) -> u8 {
        let mut doubled = (value as u16) << 1;
        if value & 0x80 != 0 {
            doubled ^= 0x11d;
        }
        (doubled & 0xff) as u8
    }

    const fn build_cd_ecc_low_table() -> [u8; 256] {
        let mut table = [0_u8; 256];
        let mut value = 0usize;
        while value < 256 {
            table[value] = cd_ecc_low_value(value as u8);
            value += 1;
        }
        table
    }

    const fn build_cd_ecc_high_table() -> [u8; 256] {
        let mut table = [0_u8; 256];
        let mut value = 0usize;
        while value < 256 {
            let byte = value as u8;
            let low = cd_ecc_low_value(byte);
            table[(low ^ byte) as usize] = byte;
            value += 1;
        }
        table
    }

    const fn build_crc16_ibm3740_table() -> [u16; 256] {
        let mut table = [0_u16; 256];
        let mut value = 0usize;
        while value < 256 {
            let mut crc = (value as u16) << 8;
            let mut bit = 0;
            while bit < 8 {
                if (crc & 0x8000) != 0 {
                    crc = (crc << 1) ^ 0x1021;
                } else {
                    crc <<= 1;
                }
                bit += 1;
            }
            table[value] = crc;
            value += 1;
        }
        table
    }

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

        fn encode_flac_frame_stream(
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

        fn build_flac_encoder_config(&self, compression_level: i32) -> flacenc::config::Encoder {
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

        fn cd_sector_has_reconstructable_ecc(sector: &[u8]) -> bool {
            sector.len() == Self::CD_SECTOR_DATA_BYTES
                && sector.starts_with(&CD_SYNC_HEADER)
                && Self::cd_sector_verify_ecc(sector)
        }

        fn cd_sector_clear_sync_and_ecc(sector: &mut [u8]) {
            if sector.len() != Self::CD_SECTOR_DATA_BYTES {
                return;
            }
            sector[..CD_SYNC_BYTES].fill(0);
            sector[CD_ECC_P_OFFSET..].fill(0);
        }

        fn cd_sector_verify_ecc(sector: &[u8]) -> bool {
            if sector.len() != Self::CD_SECTOR_DATA_BYTES {
                return false;
            }

            for ecc_byte in 0..CD_ECC_P_NUM_BYTES {
                let (low, high) = Self::cd_sector_compute_ecc(
                    sector,
                    ecc_byte,
                    CD_ECC_P_NUM_BYTES,
                    CD_ECC_P_COMPONENTS,
                );
                if sector[CD_ECC_P_OFFSET + ecc_byte] != low
                    || sector[CD_ECC_P_OFFSET + CD_ECC_P_NUM_BYTES + ecc_byte] != high
                {
                    return false;
                }
            }

            for ecc_byte in 0..CD_ECC_Q_NUM_BYTES {
                let start = (ecc_byte / 2) * CD_ECC_P_NUM_BYTES + (ecc_byte & 1);
                let (low, high) =
                    Self::cd_sector_compute_ecc(sector, start, CD_ECC_Q_STEP, CD_ECC_Q_COMPONENTS);
                if sector[CD_ECC_Q_OFFSET + ecc_byte] != low
                    || sector[CD_ECC_Q_OFFSET + CD_ECC_Q_NUM_BYTES + ecc_byte] != high
                {
                    return false;
                }
            }

            true
        }

        fn cd_sector_compute_ecc(
            sector: &[u8],
            start: usize,
            step: usize,
            components: usize,
        ) -> (u8, u8) {
            let mut value1 = 0_u8;
            let mut value2 = 0_u8;
            let mut offset = start;
            let mode2 = sector[CD_MODE_OFFSET] == 2;
            for component in 0..components {
                let value = if mode2 && offset < 4 {
                    0
                } else {
                    sector[CD_SYNC_BYTES + offset]
                };
                value1 = CD_ECC_LOW[(value ^ value1) as usize];
                value2 ^= value;
                if component + 1 < components {
                    offset += step;
                    if offset >= CD_ECC_DATA_BYTES {
                        offset -= CD_ECC_DATA_BYTES;
                    }
                }
            }
            value1 = CD_ECC_HIGH[(CD_ECC_LOW[value1 as usize] ^ value2) as usize];
            (value1, value1 ^ value2)
        }

        #[cfg(any(test, feature = "test-utils"))]
        pub fn generate_cd_sector_ecc_for_tests(sector: &mut [u8]) {
            if sector.len() != Self::CD_SECTOR_DATA_BYTES {
                return;
            }

            for ecc_byte in 0..CD_ECC_P_NUM_BYTES {
                let (low, high) = Self::cd_sector_compute_ecc(
                    sector,
                    ecc_byte,
                    CD_ECC_P_NUM_BYTES,
                    CD_ECC_P_COMPONENTS,
                );
                sector[CD_ECC_P_OFFSET + ecc_byte] = low;
                sector[CD_ECC_P_OFFSET + CD_ECC_P_NUM_BYTES + ecc_byte] = high;
            }

            for ecc_byte in 0..CD_ECC_Q_NUM_BYTES {
                let start = (ecc_byte / 2) * CD_ECC_P_NUM_BYTES + (ecc_byte & 1);
                let (low, high) =
                    Self::cd_sector_compute_ecc(sector, start, CD_ECC_Q_STEP, CD_ECC_Q_COMPONENTS);
                sector[CD_ECC_Q_OFFSET + ecc_byte] = low;
                sector[CD_ECC_Q_OFFSET + CD_ECC_Q_NUM_BYTES + ecc_byte] = high;
            }
        }

        #[cfg(any(test, feature = "test-utils"))]
        pub fn encode_cd_zlib_payload_for_tests(&self, hunk: &[u8]) -> Result<Vec<u8>> {
            self.compress_rust_cd_hunk(ChdCodec::CD_ZLIB, 0, hunk)
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
                    let lzma_level = Self::resolved_chd_lzma_level(compression_level);
                    Self::compress_lzma_raw_no_header_no_eopm(hunk, lzma_level, "lzma")
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
                    encoded.extend(self.encode_flac_frame_stream(
                        hunk,
                        FlacSampleByteOrder::LittleEndian,
                        compression_level,
                    )?);
                    Ok(encoded)
                }
                other => Err(RomWeaverError::Unsupported(format!(
                    "rust chd compressed create does not support codec `{}` for this media mode",
                    self.codec_label(other)
                ))),
            }
        }

        fn compress_best_rust_hunk(
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
                let needs_raw_sectors = encodable_codecs
                    .iter()
                    .any(|(_, codec)| *codec == ChdCodec::CD_FLAC);
                let normalize_ecc = encodable_codecs
                    .iter()
                    .any(|(_, codec)| *codec != ChdCodec::CD_FLAC);
                let prepared = self.prepare_cd_hunk_streams(
                    &hunk,
                    needs_raw_sectors,
                    normalize_ecc,
                    &mut scratch.cd,
                )?;
                let mut shared_streams = CdSharedCompressedStreams::default();
                for (codec_slot, codec) in encodable_codecs {
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

            Ok(best
                .filter(|(_, compressed)| {
                    self.prefer_compressed_payload(primary_codec, compressed.len(), hunk.len())
                })
                .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk)))
        }

        fn compress_rust_cd_hunk(
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

        fn prepare_cd_hunk_streams<'a>(
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
                    let sector = &mut scratch.sectors
                        [sector_start..sector_start + Self::CD_SECTOR_DATA_BYTES];
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

        fn compress_prepared_cd_hunk(
            &self,
            primary_codec: ChdCodec,
            compression_level: i32,
            hunk_len: usize,
            prepared: &PreparedCdHunk<'_>,
            shared_streams: Option<&mut CdSharedCompressedStreams>,
        ) -> Result<Vec<u8>> {
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
                other => Err(RomWeaverError::Unsupported(format!(
                    "rust chd compressed create does not support codec `{}` for disc media",
                    self.codec_label(other)
                ))),
            }
        }

        fn cd_payload_header(
            prepared: &PreparedCdHunk<'_>,
            hunk_len: usize,
            compressed_capacity_hint: usize,
        ) -> (Vec<u8>, usize, usize) {
            let ecc_bytes = prepared.frame_count.div_ceil(8);
            let comp_len_bytes = if hunk_len < 65_536 { 2 } else { 3 };
            let mut output =
                Vec::with_capacity(ecc_bytes + comp_len_bytes + compressed_capacity_hint);
            debug_assert_eq!(prepared.ecc_bitmap.len(), ecc_bytes);
            output.extend_from_slice(prepared.ecc_bitmap);
            output.resize(ecc_bytes + comp_len_bytes, 0);
            (output, ecc_bytes, comp_len_bytes)
        }

        fn write_cd_sector_stream_len(
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

        fn deflate_append(
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

        fn deflate_bytes(
            input: &[u8],
            compression: GzipCompression,
            label: &str,
        ) -> Result<Vec<u8>> {
            Self::deflate_append(Vec::new(), input, compression, label)
        }

        fn append_default_cd_subcode_deflate(
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
            Self::deflate_append(
                output,
                prepared.subcode,
                compression,
                "cd subcode zlib",
            )
        }

        fn zstd_append(
            output: Vec<u8>,
            input: &[u8],
            compression_level: i32,
            label: &str,
        ) -> Result<Vec<u8>> {
            let mut encoder = zstd::stream::write::Encoder::new(output, compression_level)
                .map_err(|error| {
                    RomWeaverError::Validation(format!("{label} compression failed: {error}"))
                })?;
            encoder.write_all(input).map_err(|error| {
                RomWeaverError::Validation(format!("{label} compression failed: {error}"))
            })?;
            encoder.finish().map_err(|error| {
                RomWeaverError::Validation(format!("{label} compression failed: {error}"))
            })
        }

        fn chd_zlib_compression(compression_level: i32) -> GzipCompression {
            if compression_level <= 0 {
                GzipCompression::default()
            } else {
                GzipCompression::new(compression_level.clamp(1, 9) as u32)
            }
        }

        fn chd_cd_subcode_compression(compression_level: i32) -> GzipCompression {
            if compression_level <= 0 {
                GzipCompression::best()
            } else {
                Self::chd_zlib_compression(compression_level)
            }
        }

        fn compress_prepared_cd_zstd_payload(
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

        fn compress_prepared_cd_zlib_payload(
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
            Self::append_default_cd_subcode_deflate(
                output,
                prepared,
                compression_level,
                shared_streams,
            )
        }

        fn compress_prepared_cd_lzma_payload(
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
            Self::append_default_cd_subcode_deflate(
                output,
                prepared,
                compression_level,
                shared_streams,
            )
        }

        fn compress_prepared_cd_flac_payload(
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

        fn resolved_chd_lzma_level(compression_level: i32) -> u32 {
            if compression_level <= 0 {
                9
            } else {
                compression_level as u32
            }
            .min(9)
        }

        fn append_lzma_raw_no_header_no_eopm(
            output: &mut Vec<u8>,
            input: &[u8],
            level: u32,
            context: &str,
        ) -> Result<()> {
            let compressed = Self::compress_lzma_raw_no_header_no_eopm(input, level, context)?;
            output.extend_from_slice(&compressed);
            Ok(())
        }

        fn compress_lzma_raw_no_header_no_eopm(
            input: &[u8],
            level: u32,
            context: &str,
        ) -> Result<Vec<u8>> {
            let mut options = Self::liblzma_chd_options(level, input.len() as u32, context)?;
            let mut filters = [
                lzma_sys::lzma_filter {
                    id: LZMA_FILTER_LZMA1EXT_NO_EOPM,
                    options: (&mut options as *mut lzma_sys::lzma_options_lzma).cast::<c_void>(),
                },
                lzma_sys::lzma_filter {
                    id: lzma_sys::LZMA_VLI_UNKNOWN,
                    options: ptr::null_mut(),
                },
            ];

            let mut capacity = input
                .len()
                .saturating_add(input.len() / 8)
                .saturating_add(4096)
                .max(4096);
            loop {
                let mut compressed = vec![0_u8; capacity];
                let mut output_pos = 0usize;
                let status = unsafe {
                    lzma_sys::lzma_raw_buffer_encode(
                        filters.as_mut_ptr(),
                        ptr::null(),
                        input.as_ptr(),
                        input.len(),
                        compressed.as_mut_ptr(),
                        &mut output_pos,
                        compressed.len(),
                    )
                };

                match status {
                    lzma_sys::LZMA_OK => {
                        compressed.truncate(output_pos);
                        return Ok(compressed);
                    }
                    lzma_sys::LZMA_BUF_ERROR => {
                        let next_capacity = capacity.saturating_mul(2);
                        if next_capacity <= capacity {
                            return Err(RomWeaverError::Validation(format!(
                                "{context} compression failed: liblzma output buffer overflow"
                            )));
                        }
                        capacity = next_capacity;
                    }
                    other => {
                        return Err(RomWeaverError::Validation(format!(
                            "{context} compression failed: {}",
                            Self::liblzma_status_name(other)
                        )));
                    }
                }
            }
        }

        fn liblzma_chd_options(
            level: u32,
            reduce_size: u32,
            context: &str,
        ) -> Result<lzma_sys::lzma_options_lzma> {
            let mut options =
                unsafe { MaybeUninit::<lzma_sys::lzma_options_lzma>::zeroed().assume_init() };
            let preset_status = unsafe { lzma_sys::lzma_lzma_preset(&mut options, level.min(9)) };
            if preset_status != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "{context} compression failed: liblzma rejected preset {level}"
                )));
            }

            options.lc = 3;
            options.lp = 0;
            options.pb = 2;
            options.dict_size = Self::chd_lzma_dict_size(level, reduce_size);
            Ok(options)
        }

        fn liblzma_status_name(status: lzma_sys::lzma_ret) -> &'static str {
            match status {
                lzma_sys::LZMA_MEM_ERROR => "memory allocation failed",
                lzma_sys::LZMA_MEMLIMIT_ERROR => "memory limit reached",
                lzma_sys::LZMA_OPTIONS_ERROR => "unsupported options",
                lzma_sys::LZMA_DATA_ERROR => "input data error",
                lzma_sys::LZMA_BUF_ERROR => "output buffer too small",
                lzma_sys::LZMA_PROG_ERROR => "programming error",
                _ => "unknown liblzma error",
            }
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
            hunk_bytes: u32,
            unit_bytes: u32,
        ) -> Result<(Vec<u8>, u16, u8, u8, u8, u64)> {
            let mut raw_map = vec![0_u8; entries.len().saturating_mul(12)];
            for (index, entry) in entries.iter().enumerate() {
                let offset = index.saturating_mul(12);
                raw_map[offset] = entry.compression_type;
                let map_length = if entry.compression_type == Self::CHD_V5_MAP_TYPE_UNCOMPRESSED {
                    hunk_bytes
                } else {
                    entry.length
                };
                Self::write_u24_be(&mut raw_map[offset + 1..offset + 4], map_length)?;
                Self::write_u48_be(&mut raw_map[offset + 4..offset + 10], entry.offset)?;
                raw_map[offset + 10..offset + 12].copy_from_slice(&entry.crc16.to_be_bytes());
            }
            let map_crc = Self::crc16_ibm3740(&raw_map);
            let length_bits = Self::bits_for_value(
                entries
                    .iter()
                    .filter(|entry| entry.compression_type <= Self::CHD_V5_MAP_TYPE_COMPRESSED_MAX)
                    .map(|entry| entry.length)
                    .max()
                    .unwrap_or_default(),
            );
            let mut first_offset = 0_u64;
            for entry in entries {
                if let 0..=Self::CHD_V5_MAP_TYPE_UNCOMPRESSED = entry.compression_type
                    && first_offset == 0
                {
                    first_offset = entry.offset;
                }
            }

            let units_per_hunk = u64::from(hunk_bytes / unit_bytes.max(1));
            let mut map_symbols = Vec::with_capacity(entries.len());
            let mut max_self = 0_u64;
            let mut max_parent = 0_u64;
            let mut last_self = 0_u64;
            let mut last_parent = 0_u64;
            for (hunk_index, entry) in entries.iter().enumerate() {
                match entry.compression_type {
                    Self::CHD_V5_MAP_TYPE_SELF => {
                        let symbol = if entry.offset == last_self {
                            Self::CHD_V5_MAP_TYPE_SELF0
                        } else if entry.offset == last_self.saturating_add(1) {
                            last_self = last_self.saturating_add(1);
                            Self::CHD_V5_MAP_TYPE_SELF1
                        } else {
                            last_self = entry.offset;
                            max_self = max_self.max(entry.offset);
                            Self::CHD_V5_MAP_TYPE_SELF
                        };
                        map_symbols.push(symbol);
                    }
                    Self::CHD_V5_MAP_TYPE_PARENT => {
                        let current_parent_unit =
                            (hunk_index as u64).saturating_mul(units_per_hunk);
                        let symbol = if entry.offset == current_parent_unit {
                            last_parent = entry.offset;
                            Self::CHD_V5_MAP_TYPE_PARENT_SELF
                        } else if entry.offset == last_parent {
                            Self::CHD_V5_MAP_TYPE_PARENT0
                        } else if entry.offset == last_parent.saturating_add(units_per_hunk) {
                            last_parent = entry.offset;
                            Self::CHD_V5_MAP_TYPE_PARENT1
                        } else {
                            last_parent = entry.offset;
                            max_parent = max_parent.max(entry.offset);
                            Self::CHD_V5_MAP_TYPE_PARENT
                        };
                        map_symbols.push(symbol);
                    }
                    other => map_symbols.push(other),
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
            let encoded_map_symbols = Self::rle_encode_map_symbols(&map_symbols);
            let max_symbol = encoded_map_symbols
                .iter()
                .copied()
                .max()
                .unwrap_or(0);
            if max_symbol >= Self::CHD_V5_MAP_SYMBOL_COUNT as u8 {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported compressed CHD map symbol {} for rust map encoder",
                    max_symbol
                )));
            }
            let symbol_bit_lengths = Self::map_symbol_bit_lengths(&encoded_map_symbols)?;
            let symbol_codes = Self::canonical_huffman_codes(&symbol_bit_lengths)?;

            let mut bit_writer = MsbBitWriter::new();
            Self::write_map_symbol_tree_rle(&mut bit_writer, &symbol_bit_lengths)?;

            for symbol in &encoded_map_symbols {
                let (bits, bit_count) = symbol_codes[usize::from(*symbol)]
                    .ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "missing map huffman code for compression type {}",
                            symbol
                        ))
                    })?;
                bit_writer.write_bits(u64::from(bits), bit_count);
            }

            for (entry, symbol) in entries.iter().zip(&map_symbols) {
                match *symbol {
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
                    Self::CHD_V5_MAP_TYPE_SELF0
                    | Self::CHD_V5_MAP_TYPE_SELF1
                    | Self::CHD_V5_MAP_TYPE_PARENT_SELF
                    | Self::CHD_V5_MAP_TYPE_PARENT0
                    | Self::CHD_V5_MAP_TYPE_PARENT1 => {}
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

        fn rle_encode_map_symbols(symbols: &[u8]) -> Vec<u8> {
            let mut encoded = Vec::with_capacity(symbols.len());
            let mut index = 0usize;
            let mut last_symbol = Some(0);
            while index < symbols.len() {
                let symbol = symbols[index];
                if let Some(last) = last_symbol
                    && symbol == last
                {
                    let mut run_len = 0usize;
                    while index + run_len < symbols.len() && symbols[index + run_len] == last {
                        run_len += 1;
                    }
                    if run_len >= 3 {
                        let mut remaining = run_len;
                        while remaining >= 3 {
                            let chunk = remaining.min(274);
                            if chunk >= 19 {
                                let value = chunk - 19;
                                encoded.push(Self::CHD_V5_MAP_TYPE_RLE_LARGE);
                                encoded.push(((value >> 4) & 0x0f) as u8);
                                encoded.push((value & 0x0f) as u8);
                            } else {
                                encoded.push(Self::CHD_V5_MAP_TYPE_RLE_SMALL);
                                encoded.push((chunk - 3) as u8);
                            }
                            index += chunk;
                            remaining -= chunk;
                        }
                        for _ in 0..remaining {
                            encoded.push(last);
                            index += 1;
                        }
                        continue;
                    }
                }

                encoded.push(symbol);
                last_symbol = Some(symbol);
                index += 1;
            }
            encoded
        }

        fn map_symbol_bit_lengths(symbols: &[u8]) -> Result<[u8; 16]> {
            let mut frequencies = [0_u64; Self::CHD_V5_MAP_SYMBOL_COUNT];
            for &symbol in symbols {
                let index = usize::from(symbol);
                if index >= frequencies.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported compressed CHD map symbol {symbol} for rust map encoder"
                    )));
                }
                frequencies[index] = frequencies[index].saturating_add(1);
            }
            let max_symbol = symbols.iter().copied().max().unwrap_or(0);
            let dynamic = Self::map_symbol_bit_lengths_for_frequencies(&frequencies);
            if dynamic
                .iter()
                .all(|&length| length <= 8)
                && Self::canonical_huffman_codes(&dynamic).is_ok()
            {
                return Ok(dynamic);
            }
            Self::fixed_map_symbol_bit_lengths_for_max_type(max_symbol)
        }

        fn map_symbol_bit_lengths_for_frequencies(frequencies: &[u64; 16]) -> [u8; 16] {
            #[derive(Clone)]
            struct Node {
                weight: u64,
                min_symbol: usize,
                symbol: Option<usize>,
                left: Option<usize>,
                right: Option<usize>,
            }

            let mut nodes = Vec::<Node>::new();
            let mut active = Vec::<usize>::new();
            for (symbol, &weight) in frequencies.iter().enumerate() {
                if weight == 0 {
                    continue;
                }
                let index = nodes.len();
                nodes.push(Node {
                    weight,
                    min_symbol: symbol,
                    symbol: Some(symbol),
                    left: None,
                    right: None,
                });
                active.push(index);
            }

            let mut lengths = [0_u8; 16];
            if active.is_empty() {
                lengths[0] = 1;
                return lengths;
            }
            if active.len() == 1 {
                lengths[nodes[active[0]].min_symbol] = 1;
                return lengths;
            }

            while active.len() > 1 {
                active.sort_by_key(|&index| (nodes[index].weight, nodes[index].min_symbol));
                let left = active.remove(0);
                let right = active.remove(0);
                let index = nodes.len();
                nodes.push(Node {
                    weight: nodes[left].weight.saturating_add(nodes[right].weight),
                    min_symbol: nodes[left].min_symbol.min(nodes[right].min_symbol),
                    symbol: None,
                    left: Some(left),
                    right: Some(right),
                });
                active.push(index);
            }

            fn assign_lengths(nodes: &[Node], index: usize, depth: u8, lengths: &mut [u8; 16]) {
                let node = &nodes[index];
                if let Some(symbol) = node.symbol {
                    lengths[symbol] = depth.max(1);
                    return;
                }
                if let Some(left) = node.left {
                    assign_lengths(nodes, left, depth.saturating_add(1), lengths);
                }
                if let Some(right) = node.right {
                    assign_lengths(nodes, right, depth.saturating_add(1), lengths);
                }
            }

            assign_lengths(&nodes, active[0], 0, &mut lengths);
            lengths
        }

        fn fixed_map_symbol_bit_lengths_for_max_type(max_type: u8) -> Result<[u8; 16]> {
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
                7..=15 => {
                    lengths.fill(4);
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
                let table_index = usize::from(((crc >> 8) as u8) ^ byte);
                crc = (crc << 8) ^ CRC16_IBM3740_TABLE[table_index];
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
                            track.mode.pregap_metadata_label().to_string()
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
            raw_sha1: &[u8; Self::CHD_SHA1_BYTES],
            metadata_entries: &[RustMetadataEntry],
        ) -> Result<()> {
            let overall_sha1 = Self::compute_overall_sha1(raw_sha1, metadata_entries);
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                Self::CHD_V5_HEADER_RAW_SHA1_OFFSET,
                raw_sha1,
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
