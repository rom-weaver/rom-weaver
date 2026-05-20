
#[cfg(test)]
mod tests {
    use std::{
        env,
        fs::{self, File},
        io::{Cursor, Read, Seek, SeekFrom, Write},
        path::{Path, PathBuf},
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        CSO_DEFAULT_BLOCK_BYTES, ChdCodec, ContainerCreateRequest, ContainerRegistry, SEVEN_Z,
        SelectionMatcher, SevenZContainerHandler, SevenZMethod, Z3dsContainerHandler,
    };
    use chd::{
        header::Header,
        map::{CompressionTypeV5, Map, MapEntry},
    };
    use ciso::write::write_ciso_image;
    use claxon::frame::FrameReader as FlacFrameReader;
    use flate2::{Compression as DeflateCompression, read::DeflateDecoder, write::DeflateEncoder};
    use nod::{
        common::{Compression as NodCompression, Format as NodFormat},
        read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
        write::{
            DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
            ProcessOptions as NodProcessOptions,
        },
    };
    use rom_weaver_core::{
        CancellationToken, ContainerHandler, NoopProgressSink, OperationContext, ThreadBudget,
        ThreadCapability,
    };

    fn temp_file_path_with_extension(label: &str, extension: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        env::temp_dir().join(format!(
            "rom-weaver-containers-probe-{label}-{}-{timestamp}.{extension}",
            std::process::id(),
        ))
    }

    fn temp_dir_path(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        env::temp_dir().join(format!(
            "rom-weaver-containers-tests-{label}-{}-{timestamp}",
            std::process::id(),
        ))
    }

    fn test_context(temp_root: &Path, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            temp_root.to_path_buf(),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn build_test_gamecube_iso(payload_len: usize) -> Vec<u8> {
        let total_len = (0x440 + payload_len).max(0x440);
        let mut bytes = vec![0_u8; total_len];
        bytes[..6].copy_from_slice(b"RWTEST");
        bytes[0x1C..0x20].copy_from_slice(&[0xC2, 0x33, 0x9F, 0x3D]);
        let title = b"rom-weaver-test\0";
        bytes[0x20..0x20 + title.len()].copy_from_slice(title);
        for (index, byte) in bytes[0x440..].iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        bytes
    }

    fn build_test_chav_stream(frame_count: usize, width: u16, height: u16) -> Vec<u8> {
        let pixels_per_frame = usize::from(width) * usize::from(height) * 2;
        let frame_bytes = 12 + pixels_per_frame;
        let mut data = Vec::with_capacity(frame_count * frame_bytes);
        for frame in 0..frame_count {
            data.extend_from_slice(b"chav");
            data.push(0);
            data.push(0);
            data.extend_from_slice(&0_u16.to_be_bytes());
            data.extend_from_slice(&width.to_be_bytes());
            data.extend_from_slice(&height.to_be_bytes());
            for pixel in 0..pixels_per_frame {
                data.push(((frame * 29 + pixel) % 251) as u8);
            }
        }
        data
    }

    fn assert_chd_map_contains_codec_slot(path: &Path, expected_slot: u8) {
        let expected = match expected_slot {
            0 => CompressionTypeV5::CompressionType0,
            1 => CompressionTypeV5::CompressionType1,
            2 => CompressionTypeV5::CompressionType2,
            3 => CompressionTypeV5::CompressionType3,
            _ => panic!("unsupported codec slot {expected_slot}"),
        } as u8;

        let mut file = File::open(path).expect("open chd");
        let header = Header::try_read_header(&mut file).expect("read chd header");
        let map = Map::try_read_map(&header, &mut file).expect("read chd map");
        assert!(
            map.iter().any(|entry| match entry {
                MapEntry::V5Compressed(entry) => {
                    entry.hunk_type().expect("map entry hunk type") as u8 == expected
                }
                _ => false,
            }),
            "expected at least one compressed map entry using codec slot {expected_slot} in `{}`",
            path.display()
        );
    }

    fn decode_flac_frame_stream_to_pcm(
        encoded: &[u8],
        samples_per_channel: usize,
        big_endian: bool,
    ) -> (Vec<u8>, usize) {
        let mut frame_reader = FlacFrameReader::new(Cursor::new(encoded));
        let mut block_buffer = Vec::new();
        let mut pcm = Vec::with_capacity(samples_per_channel * 4);
        let mut written = 0usize;
        while written < samples_per_channel {
            let block = frame_reader
                .read_next_or_eof(block_buffer)
                .expect("decode flac frame")
                .expect("flac stream ended before expected sample count");
            for (left, right) in block.stereo_samples() {
                if written >= samples_per_channel {
                    break;
                }
                let left_bytes = if big_endian {
                    (left as i16).to_be_bytes()
                } else {
                    (left as i16).to_le_bytes()
                };
                let right_bytes = if big_endian {
                    (right as i16).to_be_bytes()
                } else {
                    (right as i16).to_le_bytes()
                };
                pcm.extend_from_slice(&left_bytes);
                pcm.extend_from_slice(&right_bytes);
                written = written.saturating_add(1);
            }
            block_buffer = block.into_buffer();
        }
        let consumed = frame_reader.into_inner().position() as usize;
        (pcm, consumed)
    }

    fn write_test_cso(input: &Path, output: &Path) {
        let mut source = fs::File::open(input).expect("open cso source fixture");
        let mut destination = fs::File::create(output).expect("create cso fixture");
        write_ciso_image(&mut source, &mut destination, |_| {}).expect("write cso fixture");
    }

    fn write_test_wbfs(input: &Path, output: &Path) {
        let disc = NodDiscReader::new(input, &NodDiscOptions::default())
            .expect("open wbfs source fixture");
        let options = NodFormatOptions {
            format: NodFormat::Wbfs,
            compression: NodCompression::None,
            block_size: NodFormat::Wbfs.default_block_size(),
        };
        let writer = NodDiscWriter::new(disc, &options).expect("create wbfs writer");
        let mut destination = fs::File::create(output).expect("create wbfs fixture");
        let finalization = writer
            .process(
                |data, _processed, _total| destination.write_all(data.as_ref()),
                &NodProcessOptions::default(),
            )
            .expect("write wbfs fixture");
        if !finalization.header.is_empty() {
            destination
                .seek(SeekFrom::Start(0))
                .expect("seek wbfs header");
            destination
                .write_all(finalization.header.as_ref())
                .expect("write wbfs header");
        }
        destination.flush().expect("flush wbfs fixture");
    }

    fn write_test_wia(input: &Path, output: &Path) {
        let disc =
            NodDiscReader::new(input, &NodDiscOptions::default()).expect("open wia source fixture");
        let options = NodFormatOptions {
            format: NodFormat::Wia,
            compression: NodCompression::Lzma2(6),
            block_size: NodFormat::Wia.default_block_size(),
        };
        let writer = NodDiscWriter::new(disc, &options).expect("create wia writer");
        let mut destination = fs::File::create(output).expect("create wia fixture");
        let finalization = writer
            .process(
                |data, _processed, _total| destination.write_all(data.as_ref()),
                &NodProcessOptions::default(),
            )
            .expect("write wia fixture");
        if !finalization.header.is_empty() {
            destination
                .seek(SeekFrom::Start(0))
                .expect("seek wia header");
            destination
                .write_all(finalization.header.as_ref())
                .expect("write wia header");
        }
        destination.flush().expect("flush wia fixture");
    }

    const TEST_PBP_SECTOR_BYTES: usize = 0x930;
    const TEST_PBP_BLOCK_BYTES: usize = TEST_PBP_SECTOR_BYTES * 16;
    const TEST_PBP_PSAR_INDEX_OFFSET: usize = 0x4000;
    const TEST_PBP_PSAR_ISO_OFFSET: usize = 0x100000;

    fn encode_bcd(value: u8) -> u8 {
        ((value / 10) << 4) | (value % 10)
    }

    fn frames_to_msf(frames: u32) -> (u8, u8, u8) {
        let minutes = frames / (60 * 75);
        let seconds = (frames / 75) % 60;
        let frame = frames % 75;
        (minutes as u8, seconds as u8, frame as u8)
    }

    fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn build_test_pbp_iso(sector_count: u32, seed: u8) -> Vec<u8> {
        let mut bytes =
            vec![0u8; usize::try_from(sector_count).expect("sector count") * TEST_PBP_SECTOR_BYTES];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = seed.wrapping_add((index % 241) as u8);
        }
        assert!(
            bytes.len() >= TEST_PBP_BLOCK_BYTES * 2 + 108,
            "test iso must be large enough to carry the popstation size descriptor"
        );
        bytes[TEST_PBP_BLOCK_BYTES + 104..TEST_PBP_BLOCK_BYTES + 108]
            .copy_from_slice(&sector_count.to_le_bytes());
        bytes
    }

    fn compress_block_raw_deflate(block: &[u8]) -> Vec<u8> {
        let mut encoder = DeflateEncoder::new(Vec::new(), DeflateCompression::new(6));
        std::io::Write::write_all(&mut encoder, block).expect("deflate encode");
        encoder.finish().expect("deflate finish")
    }

    fn build_test_pbp_disc_psar(
        disc_id: &str,
        iso_data: &[u8],
        compress_alternate_blocks: bool,
    ) -> Vec<u8> {
        assert_eq!(disc_id.len(), 9, "disc id must be 9 chars");
        assert_eq!(
            iso_data.len() % TEST_PBP_SECTOR_BYTES,
            0,
            "iso data must align to 2352-byte sectors"
        );
        let mut padded_iso = iso_data.to_vec();
        if padded_iso.len() % TEST_PBP_BLOCK_BYTES != 0 {
            let padded_len = padded_iso.len().div_ceil(TEST_PBP_BLOCK_BYTES) * TEST_PBP_BLOCK_BYTES;
            padded_iso.resize(padded_len, 0);
        }
        let block_count = padded_iso.len() / TEST_PBP_BLOCK_BYTES;
        let mut psar = vec![0u8; TEST_PBP_PSAR_ISO_OFFSET];
        psar[..12].copy_from_slice(b"PSISOIMG0000");
        write_u32_le(
            &mut psar,
            12,
            u32::try_from(TEST_PBP_PSAR_ISO_OFFSET + padded_iso.len()).expect("disc span"),
        );

        let disc_id_bytes = disc_id.as_bytes();
        psar[0x400] = b'_';
        psar[0x401..0x405].copy_from_slice(&disc_id_bytes[..4]);
        psar[0x405] = b'_';
        psar[0x406..0x40B].copy_from_slice(&disc_id_bytes[4..9]);

        let sector_count = u32::try_from(iso_data.len() / TEST_PBP_SECTOR_BYTES).expect("sectors");
        let leadout_frames = 150u32 + sector_count;
        let (leadout_m, leadout_s, leadout_f) = frames_to_msf(leadout_frames);
        psar[0x800 + 2] = 0xA0;
        psar[0x800 + 7] = encode_bcd(1);
        psar[0x80A + 2] = 0xA1;
        psar[0x80A + 7] = encode_bcd(1);
        psar[0x814 + 2] = 0xA2;
        psar[0x814 + 7] = encode_bcd(leadout_m);
        psar[0x814 + 8] = encode_bcd(leadout_s);
        psar[0x814 + 9] = encode_bcd(leadout_f);
        psar[0x81E] = 0x41;
        psar[0x81E + 2] = encode_bcd(1);
        psar[0x81E + 3] = encode_bcd(0);
        psar[0x81E + 4] = encode_bcd(2);
        psar[0x81E + 5] = encode_bcd(0);

        let mut block_bytes = Vec::new();
        for block_index in 0..block_count {
            let start = block_index * TEST_PBP_BLOCK_BYTES;
            let end = start + TEST_PBP_BLOCK_BYTES;
            let raw_block = &padded_iso[start..end];
            let mut payload = raw_block.to_vec();
            if compress_alternate_blocks && block_index % 2 == 1 {
                let compressed = compress_block_raw_deflate(raw_block);
                if compressed.len() < raw_block.len() {
                    payload = compressed;
                }
            }
            let entry_offset = TEST_PBP_PSAR_INDEX_OFFSET + (block_index * 0x20);
            write_u32_le(
                &mut psar,
                entry_offset,
                u32::try_from(block_bytes.len()).expect("index offset"),
            );
            write_u32_le(
                &mut psar,
                entry_offset + 4,
                u32::try_from(payload.len()).expect("index length"),
            );
            block_bytes.extend_from_slice(&payload);
        }
        psar.extend_from_slice(&block_bytes);
        psar
    }

    fn build_test_pbp_fixture(discs: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        assert!(!discs.is_empty(), "at least one disc is required");
        let psar_offset = 0x100u32;
        let disc_payloads = discs
            .iter()
            .enumerate()
            .map(|(index, (disc_id, iso))| build_test_pbp_disc_psar(disc_id, iso, index % 2 == 0))
            .collect::<Vec<_>>();

        let psar = if disc_payloads.len() == 1 {
            disc_payloads[0].clone()
        } else {
            let mut data = Vec::new();
            data.extend_from_slice(b"PSTITLEIMG000000");
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&0x2CC9_C5BCu32.to_le_bytes());
            data.extend_from_slice(&0x33B5_A90Fu32.to_le_bytes());
            data.extend_from_slice(&0x06F6_B4B3u32.to_le_bytes());
            data.extend_from_slice(&0xB259_45BAu32.to_le_bytes());
            data.resize(0x200, 0);
            let position_table_offset = data.len();
            data.resize(position_table_offset + (5 * 4), 0);
            let mut cursor = 0x800usize;
            for (index, disc) in disc_payloads.iter().enumerate() {
                if data.len() < cursor {
                    data.resize(cursor, 0);
                }
                let relative = u32::try_from(cursor).expect("disc relative offset");
                write_u32_le(&mut data, position_table_offset + (index * 4), relative);
                data.extend_from_slice(disc);
                cursor = data.len();
            }
            data
        };

        let total_len = usize::try_from(psar_offset).expect("psar offset") + psar.len();
        let mut pbp = vec![0u8; total_len];
        pbp[..4].copy_from_slice(&[0x00, b'P', b'B', b'P']);
        write_u32_le(&mut pbp, 4, 0x0001_0000);
        for section in 0..8 {
            write_u32_le(&mut pbp, 8 + (section * 4), psar_offset);
        }
        let psar_start = usize::try_from(psar_offset).expect("psar offset usize");
        pbp[psar_start..psar_start + psar.len()].copy_from_slice(&psar);
        pbp
    }

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
                "zip", "zipx", "7z", "rar", "tar", "tar.gz", "tar.bz2", "tar.xz", "gz", "bz2",
                "xz", "zst", "cso", "pbp", "chd", "gcz", "wia", "tgc", "nfs", "wbfs", "rvz",
                "z3ds", "xiso"
            ]
        );
    }

    #[test]
    fn z3ds_registers_azahar_extensions() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        assert_eq!(
            handler.descriptor().extensions,
            [".z3ds", ".zcci", ".zcxi", ".zcia", ".z3dsx"]
        );
    }

    #[test]
    fn z3ds_extract_name_maps_to_matching_uncompressed_extension() {
        let handler = Z3dsContainerHandler;
        assert_eq!(
            handler.extract_name(Path::new("rom.z3ds")),
            "rom.3ds".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.zcci")),
            "rom.cci".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.zcxi")),
            "rom.cxi".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.zcia")),
            "rom.cia".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.z3dsx")),
            "rom.3dsx".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("ROM.ZCCI")),
            "ROM.cci".to_string()
        );
    }

    #[test]
    fn z3ds_capabilities_report_parallel_create_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        let capabilities = handler.capabilities();
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn gcz_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gcz").expect("gcz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn wbfs_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn wia_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wia").expect("wia handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tgc_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tgc").expect("tgc handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn nfs_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("nfs").expect("nfs handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn cso_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn pbp_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn rar_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("rar").expect("rar handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("chd-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let output_dir = temp_dir.join("out");
        let payload = (0..(512 * 1024))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        let capabilities = handler.capabilities();
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );

        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create chd");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 6);
        assert_eq!(create_execution.effective_threads, 6);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract chd");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 6);
        assert_eq!(extract_execution.effective_threads, 6);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn seven_z_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("7z").expect("7z handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn seven_z_level_mapping_tables_match_policy() {
        assert_eq!(
            (0_u32..=9)
                .map(SevenZContainerHandler::map_zstd_level)
                .collect::<Vec<_>>(),
            vec![1, 3, 5, 7, 9, 11, 13, 15, 18, 22]
        );
        assert_eq!(
            (0_u32..=9)
                .map(SevenZContainerHandler::map_brotli_quality)
                .collect::<Vec<_>>(),
            vec![0, 1, 3, 4, 5, 6, 7, 8, 10, 11]
        );
        assert_eq!(
            (0_u32..=9)
                .map(SevenZContainerHandler::map_lz4_skippable_frame_size)
                .collect::<Vec<_>>(),
            vec![
                0,
                64 * 1024,
                128 * 1024,
                256 * 1024,
                512 * 1024,
                1024 * 1024,
                2 * 1024 * 1024,
                4 * 1024 * 1024,
                8 * 1024 * 1024,
                16 * 1024 * 1024,
            ]
        );
    }

    #[test]
    fn seven_z_parse_codec_supports_expanded_codec_set() {
        let temp_dir = temp_dir_path("seven-z-codec-parse");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let execution = test_context(&temp_dir, 8).plan_threads(ThreadCapability::parallel(None));
        let handler = SevenZContainerHandler::new(&SEVEN_Z);

        let cases = [
            (None, None, SevenZMethod::LZMA2),
            (Some("lzma2"), Some(6), SevenZMethod::LZMA2),
            (Some("lzma"), Some(6), SevenZMethod::LZMA),
            (Some("store"), None, SevenZMethod::COPY),
            (Some("zstd"), Some(6), SevenZMethod::ZSTD),
            (Some("deflate"), Some(6), SevenZMethod::DEFLATE),
            (Some("bzip2"), Some(6), SevenZMethod::BZIP2),
            (Some("lz4"), Some(6), SevenZMethod::LZ4),
            (Some("brotli"), Some(6), SevenZMethod::BROTLI),
            (Some("ppmd"), Some(6), SevenZMethod::PPMD),
        ];
        for (codec, level, expected_method) in cases {
            let method = handler
                .parse_codec(codec, level, &execution)
                .expect("codec should parse");
            assert_eq!(method.method, expected_method);
        }

        let store_error = handler
            .parse_codec(Some("store"), Some(6), &execution)
            .expect_err("store level should fail");
        assert!(store_error.to_string().contains("does not accept --level"));
        let level_error = handler
            .parse_codec(Some("zstd"), Some(10), &execution)
            .expect_err("out-of-range level should fail");
        assert!(level_error.to_string().contains("out of range (0..=9)"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zip_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar").expect("tar handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_xz_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.xz").expect("tar.xz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_gz_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.gz").expect("tar.gz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_bz2_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.bz2").expect("tar.bz2 handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn gz_stream_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gz").expect("gz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn bz2_stream_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("bz2").expect("bz2 handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn zst_stream_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zst").expect("zst handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn xz_stream_capabilities_report_parallel_create_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xz").expect("xz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn zip_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("zip-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..8 {
            let path = input_dir.join(format!("file-{index}.bin"));
            let content = (0..32_768)
                .map(|offset| (offset as u8).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.zip");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "zip".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zip");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract zip");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        for index in 0..8 {
            let path = output_dir.join(format!("input/file-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..32_768)
                .map(|offset| (offset as u8).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zip_runtime_threads_fall_back_to_single_thread_for_single_entry() {
        let temp_dir = temp_dir_path("zip-thread-single-entry");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        let input_path = input_dir.join("single.bin");
        let source = (0..65_536)
            .map(|index| (index % 239) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, &source).expect("write fixture");
        let archive_path = temp_dir.join("payload.zip");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");

        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "zip".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zip");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 1);
        assert!(!create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract zip");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 1);
        assert!(!extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("input/single.bin")).expect("read extracted file");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_gz_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-gz-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..6 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(5).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar.gz");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.gz").expect("tar.gz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar.gz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar.gz");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar.gz");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        for index in 0..6 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(5).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_bz2_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-bz2-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..6 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(9).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar.bz2");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.bz2").expect("tar.bz2 handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar.bz2".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar.bz2");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar.bz2");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        for index in 0..6 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(9).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..8 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(256 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(7).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar").expect("tar handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar");

        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        for index in 0..8 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(256 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(7).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_xz_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-xz-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..6 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(3).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar.xz");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.xz").expect("tar.xz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar.xz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar.xz");

        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar.xz");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        for index in 0..6 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(3).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn gz_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("gz-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.gz");
        let output_dir = temp_dir.join("out");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(31))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gz").expect("gz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "gz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create gz");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract gz");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn bz2_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("bz2-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.bz2");
        let output_dir = temp_dir.join("out");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(37))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("bz2").expect("bz2 handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "bz2".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create bz2");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract bz2");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zst_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("zst-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.zst");
        let output_dir = temp_dir.join("out");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(13))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zst").expect("zst handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "zst".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zst");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract zst");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zst_stream_inspect_reports_uncompressed_bytes() {
        let temp_dir = temp_dir_path("zst-stream-inspect");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.zst");
        let payload = (0..(512 * 1024))
            .map(|index| (index as u8).wrapping_mul(7))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zst").expect("zst handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "zst".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zst");

        let report = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: archive_path,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("inspect zst");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            report
                .label
                .contains(&format!("{} bytes uncompressed", payload.len())),
            "inspect label mismatch: {}",
            report.label
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn xz_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("xz-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.xz");
        let output_dir = temp_dir.join("out");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(11))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xz").expect("xz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "xz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create xz");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract xz");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_extract_round_trips_to_iso_output() {
        let temp_dir = temp_dir_path("cso-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let compressed_cso = temp_dir.join("disc.cso");
        let output_dir = temp_dir.join("out");

        let source = (0..(CSO_DEFAULT_BLOCK_BYTES * 4))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut source = source;
        if let Some(last) = source.last_mut() {
            *last = 0;
        }
        fs::write(&input_iso, &source).expect("write source fixture");
        write_test_cso(&input_iso, &compressed_cso);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: compressed_cso,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect("extract cso");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wbfs_extract_round_trips_to_iso_output() {
        let temp_dir = temp_dir_path("wbfs-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let compressed_wbfs = temp_dir.join("disc.wbfs");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0x8000);
        fs::write(&input_iso, &source).expect("write source fixture");
        write_test_wbfs(&input_iso, &compressed_wbfs);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: compressed_wbfs,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wbfs");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wbfs_create_and_extract_round_trip() {
        let temp_dir = temp_dir_path("wbfs-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_wbfs = temp_dir.join("disc.wbfs");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0xA000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso.clone()],
                    output: output_wbfs.clone(),
                    format: "wbfs".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create wbfs");
        assert_eq!(
            create_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        assert!(output_wbfs.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_wbfs,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wbfs");
        assert_eq!(
            extract_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wbfs_create_rejects_compressed_codec() {
        let temp_dir = temp_dir_path("wbfs-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_wbfs = temp_dir.join("disc.wbfs");
        let source = build_test_gamecube_iso(0x3000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_wbfs,
                    format: "wbfs".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("wbfs create should reject compressed codec");
        assert!(
            error.to_string().contains("unsupported wbfs codec `zstd`"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wia_extract_round_trips_to_iso_output() {
        let temp_dir = temp_dir_path("wia-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let compressed_wia = temp_dir.join("disc.wia");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0x7000);
        fs::write(&input_iso, &source).expect("write source fixture");
        write_test_wia(&input_iso, &compressed_wia);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wia").expect("wia handler");
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: compressed_wia,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wia");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wia_create_and_extract_round_trip() {
        let temp_dir = temp_dir_path("wia-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_wia = temp_dir.join("disc.wia");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0xA000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wia").expect("wia handler");
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso.clone()],
                    output: output_wia.clone(),
                    format: "wia".to_string(),
                    codec: Some("lzma2".to_string()),
                    level: Some(6),
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create wia");
        assert_eq!(
            create_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        assert!(output_wia.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_wia,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wia");
        assert_eq!(
            extract_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn nfs_create_returns_clear_error() {
        let temp_dir = temp_dir_path("nfs-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_nfs = temp_dir.join("disc.nfs");
        let source = build_test_gamecube_iso(0x3000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("nfs").expect("nfs handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_nfs,
                    format: "nfs".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("nfs create should error");
        assert!(
            error
                .to_string()
                .contains("nfs compression is not supported"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tgc_create_rejects_compressed_codec() {
        let temp_dir = temp_dir_path("tgc-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_tgc = temp_dir.join("disc.tgc");
        let source = build_test_gamecube_iso(0x3000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tgc").expect("tgc handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_tgc,
                    format: "tgc".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("tgc create should reject compressed codec");
        assert!(
            error.to_string().contains("unsupported tgc codec `zstd`"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_create_and_extract_round_trip() {
        let temp_dir = temp_dir_path("cso-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_cso = temp_dir.join("disc.cso");
        let output_dir = temp_dir.join("out");
        let mut source = (0..(CSO_DEFAULT_BLOCK_BYTES * 4))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        if let Some(last) = source.last_mut() {
            *last = 0;
        }
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso.clone()],
                    output: output_cso.clone(),
                    format: "cso".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create cso");
        assert_eq!(
            create_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        assert!(output_cso.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_cso,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect("extract cso");
        assert_eq!(
            extract_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_create_rejects_compressed_codec() {
        let temp_dir = temp_dir_path("cso-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("input.iso");
        let output_cso = temp_dir.join("output.cso");
        fs::write(&input_iso, vec![0_u8; CSO_DEFAULT_BLOCK_BYTES]).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_cso,
                    format: "cso".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("cso create should reject compressed codec");
        assert!(
            error.to_string().contains("unsupported cso codec `zstd`"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_lists_and_extracts_single_disc_outputs() {
        let temp_dir = temp_dir_path("pbp-single");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_iso = build_test_pbp_iso(64, 7);
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", source_iso.clone())]);
        let source_path = temp_dir.join("game.pbp");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let context = test_context(&temp_dir, 1);

        let inspect = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: source_path.clone(),
                },
                &context,
            )
            .expect("inspect pbp");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(inspect.label.contains("pbp: 1 disc(s)"));
        assert!(inspect.label.contains("SLUS00001"));

        let entries = handler
            .list_entries(
                &rom_weaver_core::ContainerInspectRequest {
                    source: source_path.clone(),
                },
                &context,
            )
            .expect("list entries");
        assert_eq!(
            entries,
            vec!["game.cue".to_string(), "game.bin".to_string()]
        );

        let out_dir = temp_dir.join("out");
        let extract = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: out_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &context,
            )
            .expect("extract pbp");
        assert_eq!(extract.status, rom_weaver_core::OperationStatus::Succeeded);
        assert_eq!(fs::read(out_dir.join("game.bin")).expect("bin"), source_iso);
        let cue_text = fs::read_to_string(out_dir.join("game.cue")).expect("cue text");
        assert!(cue_text.contains("TRACK 01 MODE2/2352"));
        assert!(cue_text.contains("INDEX 01 00:02:00"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_multi_disc_selection_supports_exact_glob_and_cue_fanout() {
        let temp_dir = temp_dir_path("pbp-multi");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let disc1_iso = build_test_pbp_iso(72, 11);
        let disc2_iso = build_test_pbp_iso(80, 29);
        let pbp_bytes = build_test_pbp_fixture(vec![
            ("SLUS00001", disc1_iso.clone()),
            ("SLUS00002", disc2_iso.clone()),
        ]);
        let source_path = temp_dir.join("multi.pbp");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let context = test_context(&temp_dir, 1);

        let entries = handler
            .list_entries(
                &rom_weaver_core::ContainerInspectRequest {
                    source: source_path.clone(),
                },
                &context,
            )
            .expect("list entries");
        assert_eq!(
            entries,
            vec![
                "multi.disc01.cue".to_string(),
                "multi.disc01.bin".to_string(),
                "multi.disc02.cue".to_string(),
                "multi.disc02.bin".to_string(),
            ]
        );

        let selected_cue_dir = temp_dir.join("selected-cue");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path.clone(),
                    out_dir: selected_cue_dir.clone(),
                    selections: vec!["multi.disc02.cue".to_string()],
                    split_bin: false,
                    parent: None,
                },
                &context,
            )
            .expect("extract selected cue");
        assert!(selected_cue_dir.join("multi.disc02.cue").exists());
        assert!(selected_cue_dir.join("multi.disc02.bin").exists());
        assert!(!selected_cue_dir.join("multi.disc01.cue").exists());
        assert!(!selected_cue_dir.join("multi.disc01.bin").exists());
        assert_eq!(
            fs::read(selected_cue_dir.join("multi.disc02.bin")).expect("disc2 bin"),
            disc2_iso
        );

        let selected_glob_dir = temp_dir.join("selected-glob");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: selected_glob_dir.clone(),
                    selections: vec!["multi.disc0?.bin".to_string()],
                    split_bin: false,
                    parent: None,
                },
                &context,
            )
            .expect("extract glob");
        assert!(selected_glob_dir.join("multi.disc01.bin").exists());
        assert!(selected_glob_dir.join("multi.disc02.bin").exists());
        assert!(!selected_glob_dir.join("multi.disc01.cue").exists());
        assert!(!selected_glob_dir.join("multi.disc02.cue").exists());
        assert_eq!(
            fs::read(selected_glob_dir.join("multi.disc01.bin")).expect("disc1 bin"),
            disc1_iso
        );
        assert_eq!(
            fs::read(selected_glob_dir.join("multi.disc02.bin")).expect("disc2 bin"),
            disc2_iso
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_extract_reports_missing_selection() {
        let temp_dir = temp_dir_path("pbp-missing-select");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", build_test_pbp_iso(64, 5))]);
        let source_path = temp_dir.join("single.pbp");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let error = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: temp_dir.join("out"),
                    selections: vec!["single.missing.cue".to_string()],
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("missing selection should fail");
        assert!(
            error
                .to_string()
                .contains("requested selections were not found")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_rejects_invalid_magic_and_payload_headers() {
        let temp_dir = temp_dir_path("pbp-invalid");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");

        let bad_magic_path = temp_dir.join("bad-magic.pbp");
        let mut bad_magic_header = vec![0u8; 0x28];
        bad_magic_header[..4].copy_from_slice(b"bad!");
        fs::write(&bad_magic_path, bad_magic_header).expect("bad magic fixture");
        let bad_magic_error = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: bad_magic_path,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("inspect should fail for bad magic");
        assert!(bad_magic_error.to_string().contains("missing \\0PBP magic"));

        let mut bad_payload =
            build_test_pbp_fixture(vec![("SLUS00001", build_test_pbp_iso(64, 19))]);
        let psar_offset = u32::from_le_bytes([
            bad_payload[0x24],
            bad_payload[0x25],
            bad_payload[0x26],
            bad_payload[0x27],
        ]) as usize;
        bad_payload[psar_offset..psar_offset + 16].copy_from_slice(b"NOT-A-PSAR-SIGN!");
        let bad_payload_path = temp_dir.join("bad-payload.pbp");
        fs::write(&bad_payload_path, bad_payload).expect("bad payload fixture");

        let bad_payload_error = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: bad_payload_path,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("inspect should fail for bad payload");
        assert!(
            bad_payload_error
                .to_string()
                .contains("supported PS1 DATA.PSAR signature")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn xiso_capabilities_disable_container_create() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xiso").expect("xiso handler");
        let capabilities = handler.capabilities();
        assert!(!capabilities.inspect);
        assert!(!capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::single_threaded()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn cso_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("cso-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.iso");
        let output_path = temp_dir.join("disc.cso");
        let output_dir = temp_dir.join("out");
        let mut source = (0..(12 * 1024 * 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        if let Some(last) = source.last_mut() {
            *last = 0;
        }
        fs::write(&input_path, &source).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let capabilities = handler.capabilities();

        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: output_path.clone(),
                    format: "cso".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create cso");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract cso");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_extract_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("pbp-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_iso = build_test_pbp_iso(4096, 23);
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", source_iso.clone())]);
        let source_path = temp_dir.join("game.pbp");
        let out_dir = temp_dir.join("out");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let capabilities = handler.capabilities();
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: out_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract pbp");

        let execution = report.thread_execution.expect("thread execution");
        assert!(capabilities.extract_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(out_dir.join("game.bin")).expect("bin"), source_iso);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn rvz_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("rvz-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.iso");
        let output_path = temp_dir.join("disc.rvz");
        fs::write(&input_path, build_test_gamecube_iso(0xA000)).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("rvz").expect("rvz handler");
        let capabilities = handler.capabilities();
        let report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: output_path.clone(),
                    format: "rvz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("rvz create");

        let execution = report.thread_execution.expect("thread execution");
        assert!(capabilities.create_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(execution.used_parallelism);
        assert!(output_path.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_create_runtime_threads_match_capability_with_single_chunk_input() {
        let temp_dir = temp_dir_path("z3ds-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.3ds");
        let output_path = temp_dir.join("disc.z3ds");
        let source = (0..65_536)
            .map(|index| (index % 223) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, source).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        let capabilities = handler.capabilities();
        let report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: output_path.clone(),
                    format: "z3ds".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("z3ds create");

        let execution = report.thread_execution.expect("thread execution");
        assert!(capabilities.create_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert!(output_path.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_extract_runtime_threads_match_capability_with_single_chunk_input() {
        let temp_dir = temp_dir_path("z3ds-extract-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.3ds");
        let archive_path = temp_dir.join("disc.z3ds");
        let output_dir = temp_dir.join("out");
        let source = (0..65_536)
            .map(|index| (index % 223) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, &source).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: archive_path.clone(),
                    format: "z3ds".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("z3ds create");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(create_execution.effective_threads, 1);
        assert!(!create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("z3ds extract");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 1);
        assert!(!extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("disc.3ds")).expect("read extracted file");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn seven_z_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("seven-z-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        let archive_path = temp_dir.join("payload.7z");
        let output_dir = temp_dir.join("out");
        let source_bytes = (0..(64 * 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, &source_bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("7z").expect("7z handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: archive_path.clone(),
                    format: "7z".to_string(),
                    codec: Some("lzma2".to_string()),
                    level: Some(6),
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create seven-z");

        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);
        assert!(archive_path.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract seven-z");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        let extracted_bytes =
            fs::read(output_dir.join("payload.bin")).expect("read extracted file");
        assert_eq!(extracted_bytes, source_bytes);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn seven_z_round_trip_supports_expanded_codec_set() {
        let temp_dir = temp_dir_path("seven-z-expanded-codec-roundtrip");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        let source_bytes = (0..(96 * 1024))
            .map(|index| (index as u8).wrapping_mul(29))
            .collect::<Vec<_>>();
        fs::write(&input_path, &source_bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("7z").expect("7z handler");
        let capabilities = handler.capabilities();

        for codec in ["zstd", "deflate", "bzip2", "lz4", "brotli", "ppmd"] {
            let archive_path = temp_dir.join(format!("payload-{codec}.7z"));
            let output_dir = temp_dir.join(format!("out-{codec}"));

            let create_report = handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![input_path.clone()],
                        output: archive_path.clone(),
                        format: "7z".to_string(),
                        codec: Some(codec.to_string()),
                        level: Some(6),
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect("create seven-z with codec");
            let create_execution = create_report.thread_execution.expect("thread execution");
            assert!(
                capabilities
                    .create_threads
                    .supports_execution(&create_execution)
            );

            let extract_report = handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path,
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        split_bin: false,
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect("extract seven-z with codec");
            let extract_execution = extract_report.thread_execution.expect("thread execution");
            assert!(
                capabilities
                    .extract_threads
                    .supports_execution(&extract_execution)
            );

            let extracted = fs::read(output_dir.join("payload.bin")).expect("read extracted file");
            assert_eq!(extracted, source_bytes);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn probe_prefers_signature_over_mismatched_extension() {
        let path = temp_file_path_with_extension("seven-z-signature", "zip");
        fs::write(&path, [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C]).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.probe(&path).expect("7z probe");
        assert_eq!(handler.descriptor().name, "7z");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_unknown_extension_with_chd_signature_to_chd_handler() {
        let path = temp_file_path_with_extension("chd-signature", "bin");
        fs::write(&path, b"MComprHD\0\0\0\0").expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.probe(&path).expect("chd probe");
        assert_eq!(handler.descriptor().name, "chd");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_pbp_signature_even_with_wrong_extension() {
        let path = temp_file_path_with_extension("pbp-signature", "bin");
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", build_test_pbp_iso(64, 17))]);
        fs::write(&path, pbp_bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.probe(&path).expect("pbp probe");
        assert_eq!(handler.descriptor().name, "pbp");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recommend_compress_format_returns_rvz_for_gamecube_wii_discs() {
        let path = temp_file_path_with_extension("recommend-rvz", "iso");
        fs::write(&path, build_test_gamecube_iso(64 * 1024)).expect("fixture");

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&path);
        assert_eq!(recommendation.format_name, "rvz");
        assert_eq!(recommendation.reason, "wii-gc-disc");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recommend_compress_format_returns_rvz_for_wbfs_inputs() {
        let temp_dir = temp_dir_path("recommend-rvz-wbfs");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let input_wbfs = temp_dir.join("disc.wbfs");
        fs::write(&input_iso, build_test_gamecube_iso(64 * 1024)).expect("fixture");
        write_test_wbfs(&input_iso, &input_wbfs);

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&input_wbfs);
        assert_eq!(recommendation.format_name, "rvz");
        assert_eq!(recommendation.reason, "wii-gc-disc");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn recommend_compress_format_returns_rvz_for_wia_inputs() {
        let temp_dir = temp_dir_path("recommend-rvz-wia");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let input_wia = temp_dir.join("disc.wia");
        fs::write(&input_iso, build_test_gamecube_iso(64 * 1024)).expect("fixture");
        write_test_wia(&input_iso, &input_wia);

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&input_wia);
        assert_eq!(recommendation.format_name, "rvz");
        assert_eq!(recommendation.reason, "wii-gc-disc");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn recommend_compress_format_returns_chd_for_unrecognized_inputs() {
        let path = temp_file_path_with_extension("recommend-chd", "bin");
        fs::write(&path, b"not-a-disc").expect("fixture");

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&path);
        assert_eq!(recommendation.format_name, "chd");
        assert_eq!(recommendation.reason, "not-wii-gc-or-unrecognized");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn chd_mode_aliases_route_to_chd_handler() {
        let registry = ContainerRegistry::new();
        for alias in ["chd", "chd-cd", "chd-dvd", "chd-raw", "chd-hd"] {
            let handler = registry
                .find_by_name(alias)
                .expect("chd alias should resolve");
            assert_eq!(handler.descriptor().name, "chd");
        }
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_create_mode_overrides_adjust_inferred_kind() {
        let handler = super::ChdContainerHandler;
        let input = Path::new("disc.iso");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd", input, 2048 * 8)
                .expect("auto kind"),
            "dvd"
        );
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd-cd", input, 2048 * 8)
                .expect("cd override"),
            "cd"
        );
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd-raw", input, 2048 * 8)
                .expect("raw override"),
            "raw"
        );
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd-hd", input, 512 * 8)
                .expect("hd override"),
            "hd"
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_cd_override_rejects_invalid_raw_sector_size() {
        let handler = super::ChdContainerHandler;
        let error = handler
            .infer_create_kind_label_for_tests("chd-cd", Path::new("disc.bin"), 12345)
            .expect_err("invalid sector size should fail");
        assert!(
            error
                .to_string()
                .contains("size must be a multiple of 2352 or 2048 bytes")
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_default_codecs_for_cd_inputs_match_rust_native_policy() {
        let handler = super::ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_cd_compression_plan_for_tests()
            .expect("default cd plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::CD_ZSTD,
                ChdCodec::CD_ZLIB,
                ChdCodec::CD_FLAC,
                ChdCodec::NONE,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::CD_ZSTD);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_default_codecs_for_dvd_inputs_match_rust_native_policy() {
        let handler = super::ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_dvd_compression_plan_for_tests()
            .expect("default dvd plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::ZSTD,
                ChdCodec::ZLIB,
                ChdCodec::HUFFMAN,
                ChdCodec::FLAC,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::ZSTD);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_default_codecs_for_raw_inputs_match_rust_native_policy() {
        let handler = super::ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_raw_compression_plan_for_tests()
            .expect("default raw plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::ZSTD,
                ChdCodec::ZLIB,
                ChdCodec::HUFFMAN,
                ChdCodec::FLAC,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::ZSTD);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_explicit_codec_lists_support_multiple_codecs() {
        let handler = super::ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .explicit_compression_plan_for_tests("cdzs,cdzl+cdfl")
            .expect("explicit codec list");
        assert_eq!(
            codecs,
            [
                ChdCodec::CD_ZSTD,
                ChdCodec::CD_ZLIB,
                ChdCodec::CD_FLAC,
                ChdCodec::NONE,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::CD_ZSTD);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_explicit_codec_lists_reject_too_many_entries() {
        let handler = super::ChdContainerHandler;
        let error = handler
            .explicit_compression_plan_for_tests("cdzs,cdzl,cdfl,zstd,zlib")
            .expect_err("too many codecs should fail");
        assert!(error.to_string().contains("chd supports at most 4 codecs"));
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_explicit_codec_lists_accept_huff_and_avhuff_aliases() {
        let handler = super::ChdContainerHandler;

        let (codecs, primary_codec) = handler
            .explicit_compression_plan_for_tests("huff")
            .expect("huff alias should parse");
        assert_eq!(codecs[0], ChdCodec::HUFFMAN);
        assert_eq!(primary_codec, ChdCodec::HUFFMAN);

        let (codecs, primary_codec) = handler
            .explicit_compression_plan_for_tests("huffman")
            .expect("huffman alias should parse");
        assert_eq!(codecs[0], ChdCodec::HUFFMAN);
        assert_eq!(primary_codec, ChdCodec::HUFFMAN);

        let (codecs, primary_codec) = handler
            .explicit_compression_plan_for_tests("avhuff")
            .expect("avhuff should parse");
        assert_eq!(codecs[0], ChdCodec::AVHUFF);
        assert_eq!(primary_codec, ChdCodec::AVHUFF);

        let (codecs, primary_codec) = handler
            .explicit_compression_plan_for_tests("avhu")
            .expect("avhu alias should parse");
        assert_eq!(codecs[0], ChdCodec::AVHUFF);
        assert_eq!(primary_codec, ChdCodec::AVHUFF);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_backend_store_attempt_policy_matches_supported_codecs() {
        let handler = super::ChdContainerHandler;
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("store")
                .expect("store plan should use rust backend")
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_backend_create_attempt_accepts_huff_codec_slots() {
        let handler = super::ChdContainerHandler;
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("zstd")
                .expect("single codec should use rust backend")
        );
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("zstd,zlib")
                .expect("supported multi codec plan should use rust backend")
        );
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("zstd,zlib,huffman")
                .expect("mixed codec plan should use rust backend")
        );
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("huffman")
                .expect("huffman codec plans should use rust backend")
        );
        assert!(
            !handler
                .rust_backend_can_create_with_codec_list_for_tests("cdzs")
                .expect("disc codecs are invalid for raw create")
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_huff_codec_slots() {
        let temp_dir = temp_dir_path("chd-rust-unsupported-codec-slots");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let output_dir = temp_dir.join("out");
        let payload = (0..(512 * 1024))
            .map(|index| (index as u8).wrapping_mul(61))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("zstd,huffman".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("mixed huff codec slots should succeed");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract mixed codec slot chd");
        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(all(not(target_family = "wasm"), any(unix, windows)))]
    #[test]
    fn chd_rust_backend_parallel_extract_matches_source_payload() {
        let temp_dir = temp_dir_path("chd-rust-parallel-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let extracted_single = temp_dir.join("single.bin");
        let extracted_parallel = temp_dir.join("parallel.bin");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(29))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = super::ChdContainerHandler;
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create chd fixture");

        handler
            .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_single, 1)
            .expect("single-thread rust extract");
        handler
            .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_parallel, 6)
            .expect("parallel rust extract");

        let single = fs::read(&extracted_single).expect("read single-thread output");
        let parallel = fs::read(&extracted_parallel).expect("read parallel output");
        assert_eq!(single, payload);
        assert_eq!(parallel, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_store_create_round_trip_matches_source_payload() {
        let temp_dir = temp_dir_path("chd-rust-store-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let extracted_path = temp_dir.join("extracted.bin");
        let payload = (0..(768 * 1024))
            .map(|index| (index as u8).wrapping_mul(37))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = super::ChdContainerHandler;
        handler
            .create_raw_store_with_rust_backend_for_tests(&source_path, &archive_path)
            .expect("create rust store chd");
        handler
            .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_path, 1)
            .expect("extract rust store chd");

        let extracted = fs::read(&extracted_path).expect("read extracted output");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_extract_with_parent_option_rejects_non_parented_chd() {
        let temp_dir = temp_dir_path("chd-parent-option-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let payload = (0..(320 * 1024))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 4),
            )
            .expect("create chd fixture");

        let error = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: temp_dir.join("out"),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: Some(archive_path),
                },
                &test_context(&temp_dir, 4),
            )
            .expect_err("extract with parent should fail when source has no parent linkage");
        assert!(
            error
                .to_string()
                .to_ascii_lowercase()
                .contains("invalid parameter")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_create_and_extract_with_parent_round_trip() {
        let temp_dir = temp_dir_path("chd-parented-create-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let parent_chd = temp_dir.join("parent.chd");
        let child_chd = temp_dir.join("child.chd");
        let out_without_parent = temp_dir.join("out-no-parent");
        let out_with_parent = temp_dir.join("out-with-parent");
        let payload = (0..(448 * 1024))
            .map(|index| (index as u8).wrapping_mul(73))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: parent_chd.clone(),
                    format: "chd".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create parent chd");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: child_chd.clone(),
                    format: "chd".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: Some(parent_chd.clone()),
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create child chd with parent");

        let no_parent_error = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: child_chd.clone(),
                    out_dir: out_without_parent,
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect_err("extracting a parented chd without parent should fail");
        let no_parent_text = no_parent_error.to_string().to_ascii_lowercase();
        assert!(
            no_parent_text.contains("requires parent")
                || no_parent_text.contains("invalid parent")
                || no_parent_text.contains("missing parent")
        );
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: child_chd,
                    out_dir: out_with_parent.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: Some(parent_chd),
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extracting a parented chd with parent should succeed");
        let extracted =
            fs::read(out_with_parent.join("child.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_compressed_create_round_trip_matches_source_payload() {
        let temp_dir = temp_dir_path("chd-rust-compressed-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let payload = (0..(896 * 1024))
            .map(|index| (index as u8).wrapping_mul(41))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = super::ChdContainerHandler;
        for (codec, codec_label) in [
            (ChdCodec::ZSTD, "zstd"),
            (ChdCodec::ZLIB, "zlib"),
            (ChdCodec::LZMA, "lzma"),
            (ChdCodec::HUFFMAN, "huff"),
            (ChdCodec::FLAC, "flac"),
        ] {
            let archive_path = temp_dir.join(format!("source-{codec_label}.chd"));
            let extracted_path = temp_dir.join(format!("extracted-{codec_label}.bin"));
            handler
                .create_raw_with_rust_backend_codec_for_tests(
                    &source_path,
                    &archive_path,
                    codec,
                    0,
                    6,
                )
                .expect("create rust compressed chd");
            handler
                .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_path, 6)
                .expect("extract rust compressed chd");
            let extracted = fs::read(&extracted_path).expect("read extracted output");
            assert_eq!(extracted, payload);
            if codec == ChdCodec::HUFFMAN {
                assert_chd_map_contains_codec_slot(&archive_path, 0);
            }
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_raw_flac_payload_round_trip_matches_input_bytes() {
        let handler = super::ChdContainerHandler;
        let mut source = Vec::with_capacity(4096);
        for sample_index in 0..(4096 / 4) {
            let left = ((sample_index as i16).wrapping_mul(17)).wrapping_sub(11_000);
            let right = ((sample_index as i16).wrapping_mul(31)).wrapping_sub(9_000);
            source.extend_from_slice(&left.to_le_bytes());
            source.extend_from_slice(&right.to_le_bytes());
        }

        let encoded = handler
            .encode_raw_flac_payload_for_tests(&source)
            .expect("encode raw flac payload");
        assert_eq!(encoded.first(), Some(&b'L'));

        let (decoded, consumed) =
            decode_flac_frame_stream_to_pcm(&encoded[1..], source.len() / 4, false);
        assert_eq!(decoded, source);
        assert_eq!(consumed, encoded.len().saturating_sub(1));
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_cd_flac_payload_round_trip_matches_input_bytes() {
        let handler = super::ChdContainerHandler;
        let frame_count = 4usize;
        let frame_bytes = 2448usize;
        let sector_bytes = 2352usize;
        let subcode_bytes = 96usize;
        let mut source = Vec::with_capacity(frame_count * frame_bytes);
        for frame_index in 0..frame_count {
            for sample_index in 0..(sector_bytes / 4) {
                let left =
                    ((frame_index as i16).wrapping_mul(73)).wrapping_add(sample_index as i16);
                let right = left.wrapping_mul(3).wrapping_sub(2_000);
                source.extend_from_slice(&left.to_be_bytes());
                source.extend_from_slice(&right.to_be_bytes());
            }
            for subcode_index in 0..subcode_bytes {
                source.push(((frame_index * 59 + subcode_index) % 251) as u8);
            }
        }

        let encoded = handler
            .encode_cd_flac_payload_for_tests(&source)
            .expect("encode cdfl payload");

        let mut expected_sector_data = Vec::with_capacity(frame_count * sector_bytes);
        let mut expected_subcode_data = Vec::with_capacity(frame_count * subcode_bytes);
        for frame in source.chunks_exact(frame_bytes) {
            expected_sector_data.extend_from_slice(&frame[..sector_bytes]);
            expected_subcode_data.extend_from_slice(&frame[sector_bytes..]);
        }
        let samples_per_channel = expected_sector_data.len() / 4;
        let (decoded_sector_data, consumed) =
            decode_flac_frame_stream_to_pcm(&encoded, samples_per_channel, true);
        assert_eq!(decoded_sector_data, expected_sector_data);

        let mut subcode_decoder = DeflateDecoder::new(&encoded[consumed..]);
        let mut decoded_subcode_data = Vec::new();
        subcode_decoder
            .read_to_end(&mut decoded_subcode_data)
            .expect("decode cdfl subcode");
        assert_eq!(decoded_subcode_data, expected_subcode_data);

        let mut reconstructed = Vec::with_capacity(source.len());
        for frame_index in 0..frame_count {
            let sector_start = frame_index * sector_bytes;
            let subcode_start = frame_index * subcode_bytes;
            reconstructed
                .extend_from_slice(&decoded_sector_data[sector_start..sector_start + sector_bytes]);
            reconstructed.extend_from_slice(
                &decoded_subcode_data[subcode_start..subcode_start + subcode_bytes],
            );
        }
        assert_eq!(reconstructed, source);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_multi_codec_raw_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-multi-codec-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let output_dir = temp_dir.join("out");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(7))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("zstd,zlib".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only multi codec chd");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only multi codec chd");

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_avhuff_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-avhuff-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("video.bin");
        let archive_path = temp_dir.join("video.chd");
        let output_dir = temp_dir.join("out");
        let payload = build_test_chav_stream(4, 32, 16);
        fs::write(&source_path, &payload).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("avhuff".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only avhuff chd");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only avhuff chd");

        let extracted = fs::read(output_dir.join("video.avi")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        assert_chd_map_contains_codec_slot(&archive_path, 0);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_dvd_and_hd_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-nondisc-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let dvd_input = temp_dir.join("movie.iso");
        let hd_input = temp_dir.join("disk.img");
        let dvd_payload = (0..(2048 * 96))
            .map(|index| (index as u8).wrapping_mul(13))
            .collect::<Vec<_>>();
        let hd_payload = (0..(512 * 640))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&dvd_input, &dvd_payload).expect("write dvd fixture");
        fs::write(&hd_input, &hd_payload).expect("write hd fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");

        for (input, codec, expected_ext, expected_payload, label) in [
            (&dvd_input, "zstd", ".iso", &dvd_payload, "dvd"),
            (&hd_input, "zlib", ".img", &hd_payload, "hd"),
        ] {
            let archive_path = temp_dir.join(format!("{label}.chd"));
            let output_dir = temp_dir.join(format!("out-{label}"));
            handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![input.clone()],
                        output: archive_path.clone(),
                        format: "chd".to_string(),
                        codec: Some(codec.to_string()),
                        level: None,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("create rust-only chd");
            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path.clone(),
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        split_bin: false,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("extract rust-only chd");

            let stem = archive_path
                .file_stem()
                .and_then(|value| value.to_str())
                .expect("archive stem");
            let extracted_path = output_dir.join(format!("{stem}{expected_ext}"));
            let extracted = fs::read(extracted_path).expect("read extracted payload");
            assert_eq!(extracted, *expected_payload);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_store_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-store-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let archive_path = temp_dir.join("disc.chd");
        let output_dir = temp_dir.join("out");

        let source_payload = (0..(2352 * 128))
            .map(|index| (index as u8).wrapping_mul(19))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_cue.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("store".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only cd chd");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only cd chd");

        let extracted_bin = fs::read(output_dir.join("disc.bin")).expect("read extracted bin");
        let extracted_cue = fs::read_to_string(output_dir.join("disc.cue")).expect("read cue");
        assert_eq!(extracted_bin, source_payload);
        assert!(extracted_cue.contains("TRACK 01 MODE1/2352"));
        assert!(extracted_cue.contains("INDEX 01 00:00:00"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_compressed_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-compressed-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let source_payload = (0..(2352 * 192))
            .map(|index| (index as u8).wrapping_mul(23))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        for (codec, label) in [
            ("cdzs", "cdzs"),
            ("cdzl", "cdzl"),
            ("cdlz", "cdlz"),
            ("cdfl", "cdfl"),
        ] {
            let archive_path = temp_dir.join(format!("disc-{label}.chd"));
            let output_dir = temp_dir.join(format!("out-{label}"));
            handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![source_cue.clone()],
                        output: archive_path.clone(),
                        format: "chd".to_string(),
                        codec: Some(codec.to_string()),
                        level: None,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("create rust-only compressed cd chd");
            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path,
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        split_bin: false,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("extract rust-only compressed cd chd");
            let extracted_bin =
                fs::read(output_dir.join(format!("disc-{label}.bin"))).expect("read extracted bin");
            assert_eq!(extracted_bin, source_payload);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_dvd_default_codec_plan_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-dvd-default-codec-plan");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_iso = temp_dir.join("movie.iso");
        let archive_path = temp_dir.join("movie.chd");
        let output_dir = temp_dir.join("out");
        let source_payload = (0..(2048 * 160))
            .map(|index| (index as u8).wrapping_mul(43))
            .collect::<Vec<_>>();
        fs::write(&source_iso, &source_payload).expect("write iso fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_iso.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only dvd chd with default codec plan");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only dvd chd");
        let extracted = fs::read(output_dir.join("movie.iso")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_default_codec_plan_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-default-codec-plan");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let archive_path = temp_dir.join("disc.chd");
        let output_dir = temp_dir.join("out");
        let source_payload = (0..(2352 * 208))
            .map(|index| (index as u8).wrapping_mul(47))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_cue.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only cd chd with default codec plan");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only cd chd");

        let extracted = fs::read(output_dir.join("disc.bin")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_multi_codec_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-multi-codec-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let archive_path = temp_dir.join("disc.chd");
        let output_dir = temp_dir.join("out");
        let source_payload = (0..(2352 * 224))
            .map(|index| (index as u8).wrapping_mul(31))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_cue.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("cdzs,cdzl".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only multi codec cd chd");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only multi codec cd chd");

        let extracted = fs::read(output_dir.join("disc.bin")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_codec_aliases_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-alias-codec-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let source_payload = (0..(2352 * 200))
            .map(|index| (index as u8).wrapping_mul(53))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        for codec in ["zstd", "zlib", "lzma"] {
            let archive_path = temp_dir.join(format!("disc-{codec}.chd"));
            let output_dir = temp_dir.join(format!("out-{codec}"));
            handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![source_cue.clone()],
                        output: archive_path.clone(),
                        format: "chd".to_string(),
                        codec: Some(codec.to_string()),
                        level: None,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("create rust-only cd alias codec chd");
            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path,
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        split_bin: false,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("extract rust-only cd alias codec chd");
            let extracted = fs::read(output_dir.join(format!("disc-{codec}.bin")))
                .expect("read extracted payload");
            assert_eq!(extracted, source_payload);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn selection_matcher_preserves_exact_and_prefix_matches() {
        let mut selections =
            SelectionMatcher::new(&["content".to_string(), "disc.iso".to_string()]);
        assert!(selections.matches("content/track01.bin"));
        assert!(selections.matches("disc.iso"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn selection_matcher_supports_glob_patterns() {
        let mut selections =
            SelectionMatcher::new(&["content/**/*.bin".to_string(), "cover.???".to_string()]);
        assert!(selections.matches("content/disc.bin"));
        assert!(selections.matches("content/tracks/track01.bin"));
        assert!(selections.matches("cover.png"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn selection_matcher_reports_missing_glob_matches() {
        let mut selections = SelectionMatcher::new(&["*.cue".to_string()]);
        assert!(!selections.matches("disc.bin"));
        let error = selections
            .ensure_all_matched()
            .expect_err("missing selection");
        assert!(
            error
                .to_string()
                .contains("requested selections were not found: *.cue")
        );
    }
}
