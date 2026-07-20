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

    use crate::nod::{
        common::{Compression as NodCompression, Format as NodFormat},
        read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
        write::{
            DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
            ProcessOptions as NodProcessOptions,
        },
    };
    use crate::{
        ChdCodec, ChdContainerHandler, ContainerCreateRequest, ContainerRegistry, GCZ,
        NodHandlerCore, RVZ, RvzContainerHandler, SEVEN_Z, SelectionMatcher,
        SevenZContainerHandler, SevenZMethod, Z3dsContainerHandler, ZipContainerHandler,
        copy_progress_buffer_size, lzma2_threads_for_budget, lzma2_threads_for_budget_with_limits,
        zstd_threads_for_budget,
    };
    use chd::{
        header::Header,
        map::{CompressionTypeV5, Map, MapEntry},
    };
    use ciso::write::write_ciso_image;
    use claxon::frame::FrameReader as FlacFrameReader;
    use flate2::{Compression as DeflateCompression, read::DeflateDecoder, write::DeflateEncoder};
    use rom_weaver_codecs::encode_xz_preset;
    use rom_weaver_core::{
        CancellationToken, ContainerHandlerOperations, NoopProgressSink, OperationContext,
        RomWeaverError, ThreadBudget, ThreadCapability, ThreadExecution, UnsupportedOp,
    };

    const TEST_CSO_BLOCK_BYTES: usize = 2 * 1024;

    fn test_temp_root() -> PathBuf {
        #[cfg(target_family = "wasm")]
        {
            let candidates = [
                env::var_os("ROM_WEAVER_TEST_TMPDIR").map(PathBuf::from),
                env::var_os("TMPDIR").map(PathBuf::from),
                Some(PathBuf::from("/tmp/.rom-weaver-containers-tests-tmp")),
                Some(PathBuf::from(".rom-weaver-containers-tests-tmp")),
            ];

            for candidate in candidates.into_iter().flatten() {
                if candidate.as_os_str().is_empty() {
                    continue;
                }
                if fs::create_dir_all(&candidate).is_ok() {
                    return candidate;
                }
            }

            panic!("unable to find writable wasm temp root");
        }

        #[cfg(not(target_family = "wasm"))]
        {
            env::temp_dir()
        }
    }

    fn test_process_id() -> u32 {
        #[cfg(target_family = "wasm")]
        {
            return 0;
        }

        #[cfg(not(target_family = "wasm"))]
        {
            std::process::id()
        }
    }

    fn temp_file_path_with_extension(label: &str, extension: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        test_temp_root().join(format!(
            "rom-weaver-containers-probe-{label}-{}-{timestamp}.{extension}",
            test_process_id(),
        ))
    }

    fn temp_dir_path(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        test_temp_root().join(format!(
            "rom-weaver-containers-tests-{label}-{}-{timestamp}",
            test_process_id(),
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

    fn write_xorshift_fixture(path: &Path, byte_len: usize, seed: u32) {
        let mut file = File::create(path).expect("create xorshift fixture");
        let mut state = seed;
        let mut chunk = vec![0_u8; 1024 * 1024];
        let mut remaining = byte_len;
        while remaining > 0 {
            let len = remaining.min(chunk.len());
            for byte in &mut chunk[..len] {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte = (state & 0xff) as u8;
            }
            file.write_all(&chunk[..len]).expect("write fixture chunk");
            remaining -= len;
        }
    }

    fn write_tar_fixture(input_dir: &Path, archive_path: &Path, xz_level: Option<u32>) {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            builder
                .append_dir_all("payload", input_dir)
                .expect("append tar fixture directory");
            builder.finish().expect("finish tar fixture");
        }
        let bytes = match xz_level {
            Some(level) => encode_xz_preset(&tar_bytes, level).expect("xz encode tar fixture"),
            None => tar_bytes,
        };
        fs::write(archive_path, bytes).expect("write tar fixture");
    }

    fn assert_files_equal(left: &Path, right: &Path) {
        let mut left_file = File::open(left).expect("open left file");
        let mut right_file = File::open(right).expect("open right file");
        let mut left_chunk = vec![0_u8; 1024 * 1024];
        let mut right_chunk = vec![0_u8; 1024 * 1024];

        loop {
            let left_len = left_file
                .read(&mut left_chunk)
                .expect("read left file chunk");
            let right_len = right_file
                .read(&mut right_chunk)
                .expect("read right file chunk");
            assert_eq!(left_len, right_len, "file lengths differ");
            if left_len == 0 {
                break;
            }
            assert_eq!(&left_chunk[..left_len], &right_chunk[..right_len]);
        }
    }

    fn run_with_large_stack(label: &str, test_fn: impl FnOnce() + Send + 'static) {
        std::thread::Builder::new()
            .name(label.to_string())
            .stack_size(8 * 1024 * 1024)
            .spawn(test_fn)
            .expect("spawn large-stack test thread")
            .join()
            .expect("join large-stack test thread");
    }

    fn assert_execution_matches_capability(
        execution: &ThreadExecution,
        capability: &ThreadCapability,
        requested_threads: usize,
    ) {
        assert!(capability.supports_execution(execution));
        assert_eq!(execution.requested_threads, requested_threads);
    }

    fn assert_execution_parallel_when_available(
        execution: &ThreadExecution,
        capability: &ThreadCapability,
        requested_threads: usize,
    ) {
        assert_execution_matches_capability(execution, capability, requested_threads);
        let planned = capability
            .clone()
            .negotiate(ThreadBudget::Fixed(requested_threads));
        if planned.effective_threads > 1 {
            assert!(execution.effective_threads > 1);
            assert!(execution.used_parallelism);
        } else {
            assert_eq!(execution.effective_threads, 1);
            assert!(!execution.used_parallelism);
        }
    }

    fn expected_parallel_or_single_for_wasm_threads() -> ThreadCapability {
        ThreadCapability::parallel(None)
    }

    fn expected_regular_archive_extract_thread_capability() -> ThreadCapability {
        ThreadCapability::parallel(None)
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

    fn assert_chd_map_contains_self_copy(path: &Path) {
        let mut file = File::open(path).expect("open chd");
        let header = Header::try_read_header(&mut file).expect("read chd header");
        let map = Map::try_read_map(&header, &mut file).expect("read chd map");
        assert!(
            map.iter().any(|entry| match entry {
                MapEntry::V5Compressed(entry) => {
                    entry.hunk_type().expect("map entry hunk type") as u8
                        == CompressionTypeV5::CompressionSelf as u8
                }
                _ => false,
            }),
            "expected at least one self-copy map entry in `{}`",
            path.display()
        );
    }

    fn chd_v5_compressed_map_payload_bytes(path: &Path) -> u32 {
        let mut file = File::open(path).expect("open chd");
        let header = Header::try_read_header(&mut file).expect("read chd header");
        let Header::V5Header(header) = header else {
            panic!("expected v5 chd header");
        };
        file.seek(SeekFrom::Start(header.map_offset))
            .expect("seek to chd map");
        let mut map_bytes = [0_u8; 4];
        file.read_exact(&mut map_bytes)
            .expect("read compressed map length");
        u32::from_be_bytes(map_bytes)
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

    fn assert_extract_only_create_rejected(format: &str, output_extension: &str) {
        let temp_dir = temp_dir_path(&format!("{format}-extract-only-create"));
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        fs::write(&input_path, b"payload").expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name(format).expect("container handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: temp_dir.join(format!("payload.{output_extension}")),
                    format: format.to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("extract-only create should be rejected");
        assert!(
            error.to_string().contains("extract-only"),
            "unexpected error for {format}: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
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
        if !padded_iso.len().is_multiple_of(TEST_PBP_BLOCK_BYTES) {
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
    fn find_by_output_extension_resolves_by_extension_only() {
        let registry = ContainerRegistry::new();
        let resolved_name = |path: &str| {
            registry
                .find_by_output_extension(std::path::Path::new(path))
                .map(|handler| handler.descriptor().name)
        };
        // Create-capable container.
        assert_eq!(resolved_name("game.zip"), Some("zip"));
        // A z3ds variant extension maps to the z3ds handler.
        assert_eq!(resolved_name("game.zcia"), Some("z3ds"));
        // Extract-only containers still resolve; the create capability is the caller's concern.
        assert_eq!(resolved_name("disc.cso"), Some("cso"));
        // Unknown / non-container extensions and extensionless names resolve to nothing.
        assert_eq!(resolved_name("rom.gba"), None);
        assert_eq!(resolved_name("rom"), None);
    }

    #[test]
    fn z3ds_extract_name_maps_to_matching_uncompressed_extension() {
        let handler = Z3dsContainerHandler;
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.z3ds"), None),
            "rom.3ds".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.zcci"), None),
            "rom.cci".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.zcxi"), None),
            "rom.cxi".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.zcia"), None),
            "rom.cia".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.z3dsx"), None),
            "rom.3dsx".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("ROM.ZCCI"), None),
            "ROM.cci".to_string()
        );
    }

    #[test]
    fn z3ds_extract_name_uses_underlying_magic_for_generic_z3ds_inputs() {
        let handler = Z3dsContainerHandler;
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.z3ds"), Some(*b"NCSD")),
            "rom.cci".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.z3ds"), Some(*b"NCCH")),
            "rom.cxi".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.z3ds"), Some(*b"3DSX")),
            "rom.3dsx".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(
                Path::new("rom.z3ds"),
                Some([b'C', b'I', b'A', 0])
            ),
            "rom.cia".to_string()
        );
        assert_eq!(
            handler.extract_name_with_underlying_magic(Path::new("rom.z3ds"), Some(*b"ABCD")),
            "rom.3ds".to_string()
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
        assert!(capabilities.probe_details);
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
    fn wbfs_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn wia_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wia").expect("wia handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn tgc_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tgc").expect("tgc handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn nfs_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("nfs").expect("nfs handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn cso_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_parallel_or_single_for_wasm_threads()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn pbp_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_parallel_or_single_for_wasm_threads()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn rar_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("rar").expect("rar handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_regular_archive_extract_thread_capability()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_regular_archive_extract_thread_capability()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn regular_archive_list_entries_supports_libarchive_formats() {
        run_with_large_stack("regular-archive-libarchive-list", || {
            let temp_dir = temp_dir_path("regular-archive-libarchive-list");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let input_dir = temp_dir.join("payload");
            let nested_dir = input_dir.join("nested");
            fs::create_dir_all(&nested_dir).expect("nested dir");
            fs::write(input_dir.join("alpha.bin"), [1, 2, 3, 4]).expect("alpha fixture");
            fs::write(nested_dir.join("beta.bin"), [5, 6, 7, 8]).expect("beta fixture");

            let registry = ContainerRegistry::new();
            let context = test_context(&temp_dir, 4);

            for (format, codec, level) in [
                ("zip", Some("deflate"), Some(6)),
                ("7z", Some("lzma2"), Some(6)),
                ("tar", None, None),
                ("tar.xz", Some("lzma2"), Some(6)),
            ] {
                let handler = registry.find_by_name(format).expect("archive handler");
                let archive_path =
                    temp_dir.join(format!("payload-{}.{}", format.replace('.', "-"), format));
                let create_request = ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: format.to_string(),
                    codec: codec.map(str::to_string),
                    level,
                    parent: None,
                };
                match format {
                    "tar" | "tar.xz" => {
                        write_tar_fixture(
                            &input_dir,
                            &create_request.output,
                            level.map(|value| value as u32),
                        );
                    }
                    _ => {
                        handler
                            .create(&create_request, &context)
                            .expect("create archive");
                    }
                }

                let entries = handler
                    .list_entries(
                        &rom_weaver_core::ContainerProbeRequest {
                            source: archive_path,
                            split_bin: false,
                        },
                        &context,
                    )
                    .expect("list entries");
                assert!(
                    entries.iter().any(|entry| entry == "payload/alpha.bin"),
                    "{format} list should include alpha.bin: {entries:?}"
                );
                assert!(
                    entries
                        .iter()
                        .any(|entry| entry == "payload/nested/beta.bin"),
                    "{format} list should include beta.bin: {entries:?}"
                );
            }

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn seven_z_parse_codec_supports_lzma2_only() {
        let temp_dir = temp_dir_path("seven-z-codec-parse");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let execution = test_context(&temp_dir, 8).plan_threads(ThreadCapability::parallel(None));
        let handler = SevenZContainerHandler::new(&SEVEN_Z);

        let cases = [
            (None, None, SevenZMethod::Lzma2),
            (Some("lzma2"), Some(6), SevenZMethod::Lzma2),
        ];
        for (codec, level, expected_method) in cases {
            let method = handler
                .parse_codec(codec, level, &execution)
                .expect("codec should parse");
            assert_eq!(method, expected_method);
        }

        let level_error = handler
            .parse_codec(Some("lzma2"), Some(10), &execution)
            .expect_err("out-of-range level should fail");
        assert!(level_error.to_string().contains("out of range"));
        for codec in [
            "lzma", "xz", "store", "zstd", "deflate", "bzip2", "ppmd", "lz4",
        ] {
            let unsupported_error = handler
                .parse_codec(Some(codec), Some(6), &execution)
                .expect_err("unsupported codec should fail");
            assert!(
                unsupported_error
                    .to_string()
                    .contains("supported codec is lzma2"),
                "unexpected error for codec `{codec}`: {unsupported_error}"
            );
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zip_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_regular_archive_extract_thread_capability()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn zip_zstd_levels_preserve_requested_values() {
        let cases = [
            (-7, -7),
            (0, 0),
            (3, 3),
            (5, 5),
            (12, 12),
            (19, 19),
            (21, 21),
            (22, 22),
        ];

        for (zstd_level, zip_level) in cases {
            assert_eq!(
                ZipContainerHandler::map_zstd_level_to_zip_level(zstd_level),
                zip_level,
                "zstd level {zstd_level} should map to {zip_level}"
            );
        }
    }

    #[test]
    fn zip_create_accepts_zstd_range_edges() {
        let temp_dir = temp_dir_path("zip-zstd-level-edges");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        fs::write(&input_path, vec![0xCD; 256 * 1024]).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");

        for level in [-7, 22] {
            let create_report = handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![input_path.clone()],
                        output: temp_dir.join(format!("payload-{level}.zip")),
                        format: "zip".to_string(),
                        codec: Some("zstd".to_string()),
                        level: Some(level),
                        parent: None,
                    },
                    &test_context(&temp_dir, 4),
                )
                .unwrap_or_else(|error| panic!("zip zstd create at level {level}: {error}"));
            let create_execution = create_report
                .thread_execution
                .as_ref()
                .expect("thread execution");
            let compression = create_report
                .details
                .as_ref()
                .and_then(|details| details.get("compression"))
                .and_then(|details| details.as_object())
                .expect("compression details");
            assert_eq!(
                compression.get("codec").and_then(|value| value.as_str()),
                Some("zstd")
            );
            assert_eq!(
                compression.get("level").and_then(|value| value.as_i64()),
                Some(i64::from(level))
            );
            assert_eq!(
                compression
                    .get("effective_threads")
                    .and_then(|value| value.as_u64()),
                Some(create_execution.effective_threads as u64)
            );
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zip_zstd_create_single_threads_small_input() {
        let temp_dir = temp_dir_path("zip-zstd-small-input-threads");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        fs::write(&input_path, vec![0xAB; 512 * 1024]).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");

        let report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: temp_dir.join("payload.zip"),
                    format: "zip".to_string(),
                    codec: Some("zstd".to_string()),
                    level: Some(19),
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("zip zstd create");
        let execution = report.thread_execution.expect("thread execution");
        assert_execution_matches_capability(&execution, &ThreadCapability::parallel(Some(1)), 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zip_create_rejects_codecs_not_supported_by_libarchive() {
        let temp_dir = temp_dir_path("zip-unsupported-codecs");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        let source_bytes = (0..(96 * 1024))
            .map(|index| (index as u8).wrapping_mul(31))
            .collect::<Vec<_>>();
        fs::write(&input_path, &source_bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");

        for codec in ["lzma2", "lzma", "zlib", "gzip", "gz", "bzip2", "lz4"] {
            let archive_path = temp_dir.join(format!("payload-{codec}.zip"));
            let error = handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![input_path.clone()],
                        output: archive_path,
                        format: "zip".to_string(),
                        codec: Some(codec.to_string()),
                        level: Some(6),
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect_err("codec should be rejected");
            assert!(
                error
                    .to_string()
                    .contains("supported codecs are store, deflate, and zstd"),
                "unexpected error for codec `{codec}`: {error}"
            );
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar").expect("tar handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_regular_archive_extract_thread_capability()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn tar_xz_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.xz").expect("tar.xz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_regular_archive_extract_thread_capability()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn tar_gz_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.gz").expect("tar.gz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_regular_archive_extract_thread_capability()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn tar_bz2_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.bz2").expect("tar.bz2 handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            expected_regular_archive_extract_thread_capability()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn gz_stream_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gz").expect("gz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn gz_stream_extract_produces_byte_identical_output() {
        let temp_dir = temp_dir_path("gz-stream-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let payload_path = temp_dir.join("payload.bin");
        write_xorshift_fixture(&payload_path, 256 * 1024, 0x9E37_79B9);
        let expected = fs::read(&payload_path).expect("read payload fixture");

        let archive_path = temp_dir.join("payload.bin.gz");
        {
            let archive_file = File::create(&archive_path).expect("create gz fixture");
            let mut encoder =
                flate2::write::GzEncoder::new(archive_file, DeflateCompression::new(6));
            encoder.write_all(&expected).expect("gz encode payload");
            encoder.finish().expect("gz finish");
        }

        let output_dir = temp_dir.join("out");
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gz").expect("gz handler");
        // Exercises the probe-skipping indeterminate-progress extract path (no size pre-pass).
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 4),
            )
            .expect("extract gz stream");

        let extracted = fs::read(output_dir.join("payload.bin")).expect("read extracted payload");
        assert_eq!(extracted, expected);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn bz2_stream_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("bz2").expect("bz2 handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn zst_stream_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zst").expect("zst handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn xz_stream_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xz").expect("xz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.probe_details);
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
    fn extract_only_formats_reject_direct_create() {
        for (format, output_extension) in [
            ("zipx", "zipx"),
            ("tar", "tar"),
            ("tar.gz", "tar.gz"),
            ("tar.bz2", "tar.bz2"),
            ("tar.xz", "tar.xz"),
            ("gz", "gz"),
            ("bz2", "bz2"),
            ("xz", "xz"),
            ("zst", "zst"),
            ("cso", "cso"),
            ("nfs", "nfs"),
            ("wia", "wia"),
            ("tgc", "tgc"),
            ("wbfs", "wbfs"),
        ] {
            assert_extract_only_create_rejected(format, output_extension);
        }
    }

    #[test]
    fn zip_runtime_threads_match_capabilities_for_create_and_extract() {
        run_with_large_stack("zip-thread-parity", || {
            let temp_dir = temp_dir_path("zip-thread-parity");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let input_dir = temp_dir.join("input");
            fs::create_dir_all(&input_dir).expect("input dir");
            // 1 MiB per file (8 MiB total) so the archive is above the extract MT floor and the
            // multi-file extract still negotiates parallel to match the declared capability; a
            // smaller total now intentionally runs serially (see libarchive extract MT threshold).
            for index in 0..8 {
                let path = input_dir.join(format!("file-{index}.bin"));
                let content = (0..1_048_576)
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
            assert_execution_parallel_when_available(
                &create_execution,
                &capabilities.create_threads,
                8,
            );

            let extract_report = handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path.clone(),
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect("extract zip");

            let extract_execution = extract_report.thread_execution.expect("thread execution");
            assert_execution_parallel_when_available(
                &extract_execution,
                &capabilities.extract_threads,
                8,
            );

            for index in 0..8 {
                let path = output_dir.join(format!("input/file-{index}.bin"));
                let content = fs::read(path).expect("read extracted file");
                let expected = (0..1_048_576)
                    .map(|offset| (offset as u8).wrapping_add(index as u8))
                    .collect::<Vec<_>>();
                assert_eq!(content, expected);
            }

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn zip_runtime_threads_keep_parallel_create_for_single_entry() {
        run_with_large_stack("zip-thread-single-entry", || {
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
            assert_execution_parallel_when_available(
                &create_execution,
                &capabilities.create_threads,
                8,
            );

            let extract_report = handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path,
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect("extract zip");
            let extract_execution = extract_report.thread_execution.expect("thread execution");
            assert_execution_matches_capability(
                &extract_execution,
                &capabilities.extract_threads,
                8,
            );
            assert_eq!(extract_execution.effective_threads, 1);
            assert!(!extract_execution.used_parallelism);

            let extracted =
                fs::read(output_dir.join("input/single.bin")).expect("read extracted file");
            assert_eq!(extracted, source);

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn cso_extract_round_trips_to_iso_output() {
        let temp_dir = temp_dir_path("cso-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let compressed_cso = temp_dir.join("disc.cso");
        let output_dir = temp_dir.join("out");

        let source = (0..(TEST_CSO_BLOCK_BYTES * 4))
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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

        let probe = handler
            .probe_details(
                &rom_weaver_core::ContainerProbeRequest {
                    source: source_path.clone(),
                    split_bin: false,
                },
                &context,
            )
            .expect("probe pbp");
        assert_eq!(probe.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(probe.label.contains("pbp: 1 disc(s)"));
        assert!(probe.label.contains("SLUS00001"));

        let entries = handler
            .list_entries(
                &rom_weaver_core::ContainerProbeRequest {
                    source: source_path.clone(),
                    split_bin: false,
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &context,
            )
            .expect("extract pbp");
        assert_eq!(extract.status, rom_weaver_core::OperationStatus::Succeeded);
        assert_eq!(fs::read(out_dir.join("game.bin")).expect("bin"), source_iso);
        let cue_text = fs::read_to_string(out_dir.join("game.cue")).expect("cue text");
        assert!(cue_text.contains("TRACK 01 MODE2/2352"));
        // TOC MSF 00:02:00 (150-frame lead-in) maps to file-relative INDEX 01 00:00:00.
        assert!(cue_text.contains("INDEX 01 00:00:00"));

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
                &rom_weaver_core::ContainerProbeRequest {
                    source: source_path.clone(),
                    split_bin: false,
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
            .probe_details(
                &rom_weaver_core::ContainerProbeRequest {
                    source: bad_magic_path,
                    split_bin: false,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("probe should fail for bad magic");
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
            .probe_details(
                &rom_weaver_core::ContainerProbeRequest {
                    source: bad_payload_path,
                    split_bin: false,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("probe should fail for bad payload");
        assert!(
            bad_payload_error
                .to_string()
                .contains("supported PS1 DATA.PSAR signature")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn xiso_capabilities_allow_extract_but_disable_create() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xiso").expect("xiso handler");
        let capabilities = handler.capabilities();
        assert!(!capabilities.probe_details);
        assert!(capabilities.extract);
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
    fn cso_extract_runtime_threads_match_capability() {
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
        write_test_cso(&input_path, &output_path);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let capabilities = handler.capabilities();

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract cso");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert_execution_parallel_when_available(
            &extract_execution,
            &capabilities.extract_threads,
            8,
        );

        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn cso_extract_with_four_threads_handles_wide_reordering() {
        let temp_dir = temp_dir_path("cso-extract-four-thread-reorder");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("source.iso");
        let output_path = temp_dir.join("source.cso");
        let output_dir = temp_dir.join("out");
        write_xorshift_fixture(&input_path, 96 * 1024 * 1024, 0x0bad_c0de);
        write_test_cso(&input_path, &output_path);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 4),
            )
            .expect("extract cso with four threads");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert_eq!(extract_execution.requested_threads, 4);
        assert_files_equal(&input_path, &output_dir.join("source.iso"));

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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract pbp");

        let execution = report.thread_execution.expect("thread execution");
        assert_execution_parallel_when_available(&execution, &capabilities.extract_threads, 8);
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
        assert_execution_parallel_when_available(&execution, &capabilities.create_threads, 8);
        assert!(output_path.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn rvz_create_splits_preloader_and_processor_threads() {
        let core = NodHandlerCore::new(&RVZ, NodFormat::Rvz);

        // The budget is biased ~3/4 toward the processor (compressor), the create bottleneck, with
        // the remainder to the preloader: (preloader, processor).
        let eight_threads = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(8));
        assert_eq!(core.create_thread_counts_for_test(&eight_threads), (2, 6));

        let nine_threads = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(9));
        assert_eq!(core.create_thread_counts_for_test(&nine_threads), (2, 7));

        let single_thread = ThreadCapability::single_threaded().negotiate(ThreadBudget::Fixed(8));
        assert_eq!(core.create_thread_counts_for_test(&single_thread), (0, 0));
    }

    #[test]
    fn rvz_extract_first_progress_chunk_caps_large_outputs_at_point_one_percent() {
        let total_bytes = 1_459_978_240_u64;
        let default_buffer_size = copy_progress_buffer_size(total_bytes);
        let first_buffer_size =
            RvzContainerHandler::extract_read_buffer_size(default_buffer_size, total_bytes, 0);

        assert!(first_buffer_size > 0);
        assert!(first_buffer_size < default_buffer_size);
        assert!((first_buffer_size as u64) <= total_bytes / 1000);
        assert_eq!(
            RvzContainerHandler::extract_read_buffer_size(
                default_buffer_size,
                total_bytes,
                first_buffer_size as u64,
            ),
            default_buffer_size
        );
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
    fn z3ds_create_accepts_zstd_level_minus_7() {
        let temp_dir = temp_dir_path("z3ds-zstd-level-minus-7");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.3ds");
        let output_path = temp_dir.join("disc.z3ds");
        let source = (0..65_536)
            .map(|index| (index % 223) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, source).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        let report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: output_path.clone(),
                    format: "z3ds".to_string(),
                    codec: Some("zstd".to_string()),
                    level: Some(-7),
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("z3ds create at level -7");

        let compression = report
            .details
            .as_ref()
            .and_then(|details| details.get("compression"))
            .and_then(|details| details.as_object())
            .expect("compression details");
        assert_eq!(
            compression.get("codec").and_then(|value| value.as_str()),
            Some("zstd")
        );
        assert_eq!(
            compression.get("level").and_then(|value| value.as_i64()),
            Some(-7)
        );
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
        run_with_large_stack("seven-z-thread-parity", || {
            let temp_dir = temp_dir_path("seven-z-thread-parity");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let input_path = temp_dir.join("payload.bin");
            let archive_path = temp_dir.join("payload.7z");
            let output_dir = temp_dir.join("out");
            // Above the 16 MiB split threshold so the encoder splits into
            // seeded LZMA2 blocks and the thread cap still reports parallel (>1).
            let source_bytes = (0..(20 * 1024 * 1024))
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
            assert_execution_parallel_when_available(
                &create_execution,
                &capabilities.create_threads,
                8,
            );
            assert!(archive_path.exists());

            let extract_report = handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path.clone(),
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect("extract seven-z");

            let extract_execution = extract_report.thread_execution.expect("thread execution");
            assert_execution_matches_capability(
                &extract_execution,
                &capabilities.extract_threads,
                8,
            );
            assert_eq!(extract_execution.effective_threads, 1);
            assert!(!extract_execution.used_parallelism);

            let extracted_bytes =
                fs::read(output_dir.join("payload.bin")).expect("read extracted file");
            assert_eq!(extracted_bytes, source_bytes);

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn seven_z_small_input_reports_single_thread() {
        run_with_large_stack("seven-z-small-single-thread", || {
            let temp_dir = temp_dir_path("seven-z-small-single-thread");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let input_path = temp_dir.join("small.bin");
            let archive_path = temp_dir.join("small.7z");
            let output_dir = temp_dir.join("out");
            // Below one LZMA2 worker block (1 MiB): only a single block is
            // possible, so the reported thread count must be 1 even though 8
            // were requested. This is the size-aware accounting the cap adds.
            let source_bytes = (0..(64 * 1024))
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>();
            fs::write(&input_path, &source_bytes).expect("fixture");

            let registry = ContainerRegistry::new();
            let handler = registry.find_by_name("7z").expect("7z handler");
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

            let execution = create_report.thread_execution.expect("thread execution");
            assert_eq!(execution.requested_threads, 8);
            assert_eq!(execution.effective_threads, 1);
            assert!(!execution.used_parallelism);

            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path.clone(),
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect("extract seven-z");
            let extracted = fs::read(output_dir.join("small.bin")).expect("read extracted");
            assert_eq!(extracted, source_bytes);

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn seven_z_multi_block_seeded_create_round_trips() {
        run_with_large_stack("seven-z-multi-block", || {
            let temp_dir = temp_dir_path("seven-z-multi-block");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let input_path = temp_dir.join("multi.bin");
            let archive_path = temp_dir.join("multi.7z");
            let output_dir = temp_dir.join("out");

            // A 1.25 MiB block repeated to 24 MiB (above the 16 MiB split
            // threshold): each repeat is further than one worker block, so the
            // encoder must reference across block boundaries. That only
            // round-trips byte-for-byte if every later block's seed (preset)
            // dictionary is wired correctly and the blocks concatenate into one
            // valid LZMA2 stream (no spurious dict reset).
            let total_len = 24 * 1024 * 1024;
            let block_len = 1280 * 1024usize;
            let block = (0..block_len)
                .map(|index| (index.wrapping_mul(2654435761) >> 11) as u8)
                .collect::<Vec<u8>>();
            let mut source_bytes = Vec::with_capacity(total_len);
            while source_bytes.len() < total_len {
                source_bytes.extend_from_slice(&block);
            }
            source_bytes.truncate(total_len);
            fs::write(&input_path, &source_bytes).expect("fixture");

            let registry = ContainerRegistry::new();
            let handler = registry.find_by_name("7z").expect("7z handler");
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

            let execution = create_report.thread_execution.expect("thread execution");
            // 6 MiB yields several seeded blocks, so it must report parallel.
            assert!(execution.effective_threads > 1);
            assert!(execution.used_parallelism);

            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path.clone(),
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect("extract seven-z");
            let extracted = fs::read(output_dir.join("multi.bin")).expect("read extracted");
            assert_eq!(extracted.len(), source_bytes.len());
            assert_eq!(extracted, source_bytes);

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn seven_z_memory_budget_scales_thread_cap() {
        // 64 MiB at level 9 uses a 64 MiB dictionary, ~768 MiB per seeded worker,
        // so the worker count tracks the budget: a 1 GiB host collapses to a
        // single encoder (7-Zip-like footprint), larger budgets allow more.
        let total = 64 * 1024 * 1024;
        let gib = 1024 * 1024 * 1024;
        assert_eq!(lzma2_threads_for_budget(total, 9, gib), 1);
        assert_eq!(lzma2_threads_for_budget(total, 9, 2 * gib), 2);
        assert_eq!(lzma2_threads_for_budget(total, 9, 4 * gib), 5);
        // Never zero, even with no budget.
        assert_eq!(lzma2_threads_for_budget(total, 9, 0), 1);
        // A tiny input reduces the dictionary, so the same budget allows many
        // more workers (cheap per-worker memory).
        assert!(lzma2_threads_for_budget(1024 * 1024, 9, gib) > 10);
    }

    #[test]
    fn seven_z_level9_small_inputs_reduce_dict_under_wasm_budget() {
        let large_total = 96 * 1024 * 1024;
        let reduced_dict_total = 32 * 1024 * 1024;
        let gib = 1024 * 1024 * 1024;
        let wasm_max_threads = Some(2);

        assert_eq!(
            lzma2_threads_for_budget_with_limits(large_total, 9, gib, wasm_max_threads),
            1
        );
        assert_eq!(
            lzma2_threads_for_budget_with_limits(reduced_dict_total, 9, gib, wasm_max_threads),
            2
        );
        assert_eq!(
            lzma2_threads_for_budget_with_limits(reduced_dict_total, 9, 4 * gib, wasm_max_threads),
            2
        );
    }

    #[test]
    fn zip_zstd_memory_budget_scales_thread_cap() {
        let total = 256 * 1024 * 1024;
        let gib = 1024 * 1024 * 1024;

        // Level 22's default MT job is larger than this input, so extra zstd
        // workers add memory pressure without useful parallel jobs.
        assert_eq!(zstd_threads_for_budget(total, 22, gib), 1);
        assert_eq!(zstd_threads_for_budget(total, 22, 8 * gib), 1);
        // Lower levels have much smaller windows/job buffers and can still use
        // useful parallelism under the same budget.
        assert!(zstd_threads_for_budget(total, 3, gib) >= 8);
        assert_eq!(zstd_threads_for_budget(total, 3, 0), 1);
    }

    #[test]
    fn seven_z_round_trip_supports_lzma2_create() {
        run_with_large_stack("seven-z-lzma2-roundtrip", || {
            let temp_dir = temp_dir_path("seven-z-lzma2-roundtrip");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let input_path = temp_dir.join("payload.bin");
            let source_bytes = (0..(96 * 1024))
                .map(|index| (index as u8).wrapping_mul(29))
                .collect::<Vec<_>>();
            fs::write(&input_path, &source_bytes).expect("fixture");

            let registry = ContainerRegistry::new();
            let handler = registry.find_by_name("7z").expect("7z handler");
            let capabilities = handler.capabilities();

            for (label, codec, level) in
                [("default", None, None), ("lzma2", Some("lzma2"), Some(6))]
            {
                let archive_path = temp_dir.join(format!("payload-{label}.7z"));
                let output_dir = temp_dir.join(format!("out-{label}"));

                let create_report = handler
                    .create(
                        &ContainerCreateRequest {
                            inputs: vec![input_path.clone()],
                            output: archive_path.clone(),
                            format: "7z".to_string(),
                            codec: codec.map(str::to_string),
                            level,
                            parent: None,
                        },
                        &test_context(&temp_dir, 8),
                    )
                    .expect("create seven-z with lzma2");
                let create_execution = create_report
                    .thread_execution
                    .as_ref()
                    .expect("thread execution");
                let compression = create_report
                    .details
                    .as_ref()
                    .and_then(|details| details.get("compression"))
                    .and_then(|details| details.as_object())
                    .expect("compression details");
                assert_eq!(
                    compression.get("codec").and_then(|value| value.as_str()),
                    Some("lzma2")
                );
                assert_eq!(
                    compression.get("level").and_then(|value| value.as_i64()),
                    Some(level.unwrap_or(6) as i64)
                );
                assert_eq!(
                    compression
                        .get("effective_threads")
                        .and_then(|value| value.as_u64()),
                    Some(create_execution.effective_threads as u64)
                );
                assert!(
                    capabilities
                        .create_threads
                        .supports_execution(create_execution)
                );

                let extract_report = handler
                    .extract(
                        &rom_weaver_core::ContainerExtractRequest {
                            source: archive_path,
                            out_dir: output_dir.clone(),
                            selections: Vec::new(),
                            kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                            containing_archive: None,
                            split_bin: false,
                            ignore_common_files: false,
                            overwrite: true,
                            parent: None,
                        },
                        &test_context(&temp_dir, 8),
                    )
                    .expect("extract seven-z with codec");
                let extract_execution = extract_report
                    .thread_execution
                    .as_ref()
                    .expect("thread execution");
                let extraction = extract_report
                    .details
                    .as_ref()
                    .and_then(|details| details.get("extraction"))
                    .and_then(|details| details.as_object())
                    .expect("extraction details");
                assert_eq!(
                    extraction.get("files").and_then(|value| value.as_u64()),
                    Some(1)
                );
                assert_eq!(
                    extraction
                        .get("written_bytes")
                        .and_then(|value| value.as_u64()),
                    Some(source_bytes.len() as u64)
                );
                assert_eq!(
                    extraction
                        .get("effective_threads")
                        .and_then(|value| value.as_u64()),
                    Some(extract_execution.effective_threads as u64)
                );
                assert!(
                    capabilities
                        .extract_threads
                        .supports_execution(extract_execution)
                );

                let extracted =
                    fs::read(output_dir.join("payload.bin")).expect("read extracted file");
                assert_eq!(extracted, source_bytes);
            }

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn seven_z_create_rejects_codecs_not_supported_by_libarchive() {
        let temp_dir = temp_dir_path("seven-z-unsupported-codecs");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        let source_bytes = (0..(96 * 1024))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&input_path, &source_bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("7z").expect("7z handler");

        for codec in [
            "lzma", "zstd", "store", "deflate", "bzip2", "ppmd", "lz4", "brotli",
        ] {
            let archive_path = temp_dir.join(format!("payload-{codec}.7z"));
            let error = handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![input_path.clone()],
                        output: archive_path,
                        format: "7z".to_string(),
                        codec: Some(codec.to_string()),
                        level: Some(6),
                        parent: None,
                    },
                    &test_context(&temp_dir, 8),
                )
                .expect_err("codec should be rejected");
            assert!(
                error.to_string().contains("supported codec is lzma2"),
                "unexpected error for codec `{codec}`: {error}"
            );
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn probe_prefers_signature_over_mismatched_extension() {
        run_with_large_stack("probe-prefers-signature", || {
            let temp_dir = temp_dir_path("seven-z-signature");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let input_path = temp_dir.join("payload.bin");
            let path = temp_dir.join("payload.zip");
            fs::write(&input_path, [1, 2, 3, 4]).expect("fixture");

            let registry = ContainerRegistry::new();
            let seven_z = registry.find_by_name("7z").expect("7z handler");
            seven_z
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![input_path],
                        output: path.clone(),
                        format: "7z".to_string(),
                        codec: Some("lzma2".to_string()),
                        level: None,
                        parent: None,
                    },
                    &test_context(&temp_dir, 2),
                )
                .expect("create 7z archive");
            let handler = registry.probe(&path).expect("7z probe");
            assert_eq!(handler.descriptor().name, "7z");

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn probe_routes_unknown_extension_with_chd_signature_to_chd_handler() {
        run_with_large_stack("probe-chd-signature", || {
            let path = temp_file_path_with_extension("chd-signature", "bin");
            fs::write(&path, b"MComprHD\0\0\0\0").expect("fixture");

            let registry = ContainerRegistry::new();
            let handler = registry.probe(&path).expect("chd probe");
            assert_eq!(handler.descriptor().name, "chd");

            let _ = fs::remove_file(path);
        });
    }

    #[test]
    fn probe_routes_pbp_signature_even_with_wrong_extension() {
        run_with_large_stack("probe-pbp-signature", || {
            let path = temp_file_path_with_extension("pbp-signature", "bin");
            let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", build_test_pbp_iso(64, 17))]);
            fs::write(&path, pbp_bytes).expect("fixture");

            let registry = ContainerRegistry::new();
            let handler = registry.probe(&path).expect("pbp probe");
            assert_eq!(handler.descriptor().name, "pbp");

            let _ = fs::remove_file(path);
        });
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
    fn recommend_compress_format_returns_7z_for_unrecognized_inputs() {
        let path = temp_file_path_with_extension("recommend-7z", "bin");
        fs::write(&path, b"not-a-disc").expect("fixture");

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&path);
        assert_eq!(recommendation.format_name, "7z");
        assert_eq!(recommendation.reason, "fallback-7z-lzma2");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recommend_container_for_identity_maps_platform_and_disc_format() {
        use rom_weaver_checksum::platform_detection::platform as plat;

        // GameCube/Wii → RVZ, checked before the disc rule even though those discs report DVD.
        assert_eq!(
            crate::recommend_container_for_identity(Some(plat::GAMECUBE), Some("DVD")).format_name,
            "rvz"
        );
        assert_eq!(
            crate::recommend_container_for_identity(Some(plat::WII), Some("DVD")).format_name,
            "rvz"
        );
        // 3DS carts have no medium → z3ds.
        assert_eq!(
            crate::recommend_container_for_identity(Some(plat::N3DS), None).format_name,
            "z3ds"
        );
        // Any optical disc (known or unknown console) → CHD.
        assert_eq!(
            crate::recommend_container_for_identity(Some(plat::PS1), Some("CD")).format_name,
            "chd"
        );
        assert_eq!(
            crate::recommend_container_for_identity(None, Some("CD")).format_name,
            "chd"
        );
        // Cartridge / undetected → 7z fallback.
        assert_eq!(
            crate::recommend_container_for_identity(Some(plat::SNES), None).format_name,
            "7z"
        );
        assert_eq!(
            crate::recommend_container_for_identity(None, None).format_name,
            "7z"
        );
    }

    #[test]
    fn ambiguous_disc_image_extension_matches_bin_case_insensitively() {
        assert!(crate::is_ambiguous_disc_image_extension("bin"));
        assert!(crate::is_ambiguous_disc_image_extension(".BIN"));
        assert!(!crate::is_ambiguous_disc_image_extension("iso"));
        assert!(!crate::is_ambiguous_disc_image_extension("cue"));
        assert!(!crate::is_ambiguous_disc_image_extension(""));
    }

    #[test]
    fn likely_disc_image_size_requires_cd_or_dvd_sector_alignment() {
        // 2352 (raw CD) and 2048 (cooked) are the policy sector sizes.
        assert!(crate::is_likely_disc_image_size(Some(2352)));
        assert!(crate::is_likely_disc_image_size(Some(2352 * 1000)));
        assert!(crate::is_likely_disc_image_size(Some(2048)));
        assert!(crate::is_likely_disc_image_size(Some(2048 * 64)));
        // A bare Genesis dump (power-of-two MB) is not sector-aligned to 2352, but IS divisible by
        // 2048; pick a size that is divisible by neither.
        assert!(!crate::is_likely_disc_image_size(Some(3 * 1024 * 1024 + 1)));
        // Unknown / zero size keeps the extension-based resolution.
        assert!(crate::is_likely_disc_image_size(None));
        assert!(crate::is_likely_disc_image_size(Some(0)));
    }

    #[test]
    fn likely_disc_image_source_only_gates_ambiguous_extensions() {
        // Non-ambiguous extension is always a disc image regardless of size.
        assert!(crate::is_likely_disc_image_source(
            "iso",
            Some(3 * 1024 * 1024 + 1)
        ));
        assert!(crate::is_likely_disc_image_source("img", None));
        // Ambiguous `.bin` with a sector-aligned size is a disc image.
        assert!(crate::is_likely_disc_image_source("bin", Some(2352 * 500)));
        // Ambiguous `.bin` with a non-sector-aligned size is a bare ROM dump.
        assert!(!crate::is_likely_disc_image_source(
            "bin",
            Some(3 * 1024 * 1024 + 1)
        ));
        // Unknown size keeps the disc-image resolution for `.bin`.
        assert!(crate::is_likely_disc_image_source("bin", None));
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_create_mode_overrides_adjust_inferred_kind() {
        let handler = ChdContainerHandler;
        let input = Path::new("disc.iso");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd", input, 2048 * 8)
                .expect("auto kind"),
            "cd"
        );
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd", input, 2048 * 450_001)
                .expect("large iso auto kind"),
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_create_auto_infers_sector_sized_cd_inputs() {
        const CD_SYNC_HEADER: [u8; 12] = [
            0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00,
        ];
        // ISO9660 `CD001` descriptor byte offset for 2048-byte cooked sectors (sector 16 + 1).
        const ISO9660_COOKED_DESCRIPTOR_OFFSET: usize = 16 * 2048 + 1;

        let temp_dir = temp_dir_path("chd-cd-auto-infer");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let handler = ChdContainerHandler;

        // Raw 2352-byte `.bin` carrying a CD sync header -> cd.
        let raw_bin_path = temp_dir.join("disc.bin");
        let mut raw_bin = vec![0_u8; 2352 * 20];
        raw_bin[..CD_SYNC_HEADER.len()].copy_from_slice(&CD_SYNC_HEADER);
        fs::write(&raw_bin_path, &raw_bin).expect("write raw cd bin");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &raw_bin_path,
                    u64::try_from(raw_bin.len()).expect("size"),
                )
                .expect("bin cd kind"),
            "cd"
        );

        // Extensionless raw image with a CD sync header -> cd.
        let extensionless_path = temp_dir.join("Quality of life");
        fs::write(&extensionless_path, &raw_bin).expect("write extensionless cd image");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &extensionless_path,
                    u64::try_from(raw_bin.len()).expect("size"),
                )
                .expect("extensionless cd kind"),
            "cd"
        );

        // Cooked 2048-byte image carrying an ISO9660 descriptor -> cd.
        let cooked_path = temp_dir.join("cooked.bin");
        let mut cooked = vec![0_u8; 2048 * 20];
        cooked[ISO9660_COOKED_DESCRIPTOR_OFFSET..ISO9660_COOKED_DESCRIPTOR_OFFSET + 5]
            .copy_from_slice(b"CD001");
        fs::write(&cooked_path, &cooked).expect("write cooked cd image");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &cooked_path,
                    u64::try_from(cooked.len()).expect("size"),
                )
                .expect("cooked cd kind"),
            "cd"
        );

        // `.iso` extension is auto-classified as CD by size alone.
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd", Path::new("disc.iso"), 2048 * 8)
                .expect("iso cd kind"),
            "cd"
        );

        // Sector-sized blob with no CD evidence and no disk signature -> raw.
        let raw_blob_path = temp_dir.join("blob.bin");
        let raw_blob = (0..(2048 * 10))
            .map(|index| (index as u8).wrapping_mul(101))
            .collect::<Vec<_>>();
        fs::write(&raw_blob_path, &raw_blob).expect("write raw blob");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &raw_blob_path,
                    u64::try_from(raw_blob.len()).expect("size"),
                )
                .expect("raw blob kind"),
            "raw"
        );

        // `.raw` extension never auto-infers CD.
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd", Path::new("disc.raw"), 2048 * 8)
                .expect("raw kind"),
            "raw"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_create_auto_infers_hd_only_from_disk_signatures() {
        fn write_mbr_disk(path: &Path, sectors: usize) -> Vec<u8> {
            let mut bytes = vec![0_u8; sectors * 512];
            bytes[510] = 0x55;
            bytes[511] = 0xAA;
            let entry_offset = 446;
            bytes[entry_offset + 4] = 0x83;
            bytes[entry_offset + 8..entry_offset + 12].copy_from_slice(&1_u32.to_le_bytes());
            bytes[entry_offset + 12..entry_offset + 16]
                .copy_from_slice(&u32::try_from(sectors - 1).expect("sectors").to_le_bytes());
            fs::write(path, &bytes).expect("write mbr disk");
            bytes
        }

        fn write_gpt_disk(path: &Path, sectors: usize) -> Vec<u8> {
            let mut bytes = vec![0_u8; sectors * 512];
            let gpt_offset = 512;
            bytes[gpt_offset..gpt_offset + 8].copy_from_slice(b"EFI PART");
            bytes[gpt_offset + 8..gpt_offset + 12].copy_from_slice(&0x0001_0000_u32.to_le_bytes());
            bytes[gpt_offset + 12..gpt_offset + 16].copy_from_slice(&92_u32.to_le_bytes());
            bytes[gpt_offset + 24..gpt_offset + 32].copy_from_slice(&1_u64.to_le_bytes());
            bytes[gpt_offset + 32..gpt_offset + 40]
                .copy_from_slice(&u64::try_from(sectors - 1).expect("sectors").to_le_bytes());
            bytes[gpt_offset + 40..gpt_offset + 48].copy_from_slice(&34_u64.to_le_bytes());
            bytes[gpt_offset + 48..gpt_offset + 56]
                .copy_from_slice(&u64::try_from(sectors - 34).expect("sectors").to_le_bytes());
            bytes[gpt_offset + 72..gpt_offset + 80].copy_from_slice(&2_u64.to_le_bytes());
            bytes[gpt_offset + 80..gpt_offset + 84].copy_from_slice(&128_u32.to_le_bytes());
            bytes[gpt_offset + 84..gpt_offset + 88].copy_from_slice(&128_u32.to_le_bytes());
            fs::write(path, &bytes).expect("write gpt disk");
            bytes
        }

        fn write_ntfs_volume(path: &Path, sectors: usize) -> Vec<u8> {
            let mut bytes = vec![0_u8; sectors * 512];
            bytes[3..11].copy_from_slice(b"NTFS    ");
            bytes[11..13].copy_from_slice(&512_u16.to_le_bytes());
            bytes[13] = 8;
            bytes[40..48].copy_from_slice(&u64::try_from(sectors).expect("sectors").to_le_bytes());
            bytes[48..56].copy_from_slice(&4_u64.to_le_bytes());
            bytes[510] = 0x55;
            bytes[511] = 0xAA;
            fs::write(path, &bytes).expect("write ntfs volume");
            bytes
        }

        let temp_dir = temp_dir_path("chd-hd-auto-infer");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let handler = ChdContainerHandler;

        let mbr_path = temp_dir.join("mbr-disk");
        let mbr_bytes = write_mbr_disk(&mbr_path, 64);
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &mbr_path,
                    u64::try_from(mbr_bytes.len()).expect("size"),
                )
                .expect("mbr disk kind"),
            "hd"
        );

        let gpt_path = temp_dir.join("gpt-disk.dat");
        let gpt_bytes = write_gpt_disk(&gpt_path, 128);
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &gpt_path,
                    u64::try_from(gpt_bytes.len()).expect("size"),
                )
                .expect("gpt disk kind"),
            "hd"
        );

        let ntfs_path = temp_dir.join("ntfs-volume.dat");
        let ntfs_bytes = write_ntfs_volume(&ntfs_path, 256);
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &ntfs_path,
                    u64::try_from(ntfs_bytes.len()).expect("size"),
                )
                .expect("ntfs volume kind"),
            "hd"
        );

        let raw_path = temp_dir.join("blob.dat");
        let raw_bytes = vec![0xA5_u8; 63 * 512];
        fs::write(&raw_path, &raw_bytes).expect("write raw blob");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests(
                    "chd",
                    &raw_path,
                    u64::try_from(raw_bytes.len()).expect("size"),
                )
                .expect("raw blob kind"),
            "raw"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_cd_override_rejects_invalid_raw_sector_size() {
        let handler = ChdContainerHandler;
        let error = handler
            .infer_create_kind_label_for_tests("chd-cd", Path::new("disc.bin"), 12345)
            .expect_err("invalid sector size should fail");
        assert!(
            error
                .to_string()
                .contains("size must be a multiple of 2352 or 2048 bytes")
        );
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_default_codecs_for_cd_inputs_match_rust_native_policy() {
        let handler = ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_cd_compression_plan_for_tests()
            .expect("default cd plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::CD_LZMA,
                ChdCodec::CD_ZLIB,
                ChdCodec::CD_FLAC,
                ChdCodec::NONE,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::CD_LZMA);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_default_codecs_for_dvd_inputs_match_rust_native_policy() {
        let handler = ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_dvd_compression_plan_for_tests()
            .expect("default dvd plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::LZMA,
                ChdCodec::ZLIB,
                ChdCodec::HUFFMAN,
                ChdCodec::FLAC,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::LZMA);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_default_codecs_for_raw_inputs_match_rust_native_policy() {
        let handler = ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_raw_compression_plan_for_tests()
            .expect("default raw plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::LZMA,
                ChdCodec::ZLIB,
                ChdCodec::HUFFMAN,
                ChdCodec::FLAC,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::LZMA);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_explicit_codec_lists_support_multiple_codecs() {
        let handler = ChdContainerHandler;
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_explicit_codec_lists_reject_too_many_entries() {
        let handler = ChdContainerHandler;
        let error = handler
            .explicit_compression_plan_for_tests("cdzs,cdzl,cdfl,zstd,zlib")
            .expect_err("too many codecs should fail");
        assert!(error.to_string().contains("chd supports at most 4 codecs"));
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_explicit_codec_lists_accept_huff_and_avhuff_aliases() {
        let handler = ChdContainerHandler;

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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_backend_store_attempt_policy_matches_supported_codecs() {
        let handler = ChdContainerHandler;
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("store")
                .expect("store plan should use rust backend")
        );
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_backend_create_attempt_accepts_huff_codec_slots() {
        let handler = ChdContainerHandler;
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract mixed codec slot chd");
        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(
        all(not(target_family = "wasm"), any(unix, windows)),
        all(target_family = "wasm", rom_weaver_wasi_threads)
    ))]
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

        let handler = ChdContainerHandler;
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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

        let handler = ChdContainerHandler;
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_compressed_create_compacts_repeated_map_hunks() {
        let temp_dir = temp_dir_path("chd-rust-repeated-map");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let extracted_path = temp_dir.join("extracted.bin");
        let mut unique_hunks = Vec::with_capacity(128 * 4096);
        for hunk_index in 0..128 {
            unique_hunks.extend(std::iter::repeat_n(hunk_index as u8, 4096));
        }
        let mut payload = Vec::with_capacity(unique_hunks.len() * 4);
        for _ in 0..4 {
            payload.extend_from_slice(&unique_hunks);
        }
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = ChdContainerHandler;
        handler
            .create_raw_with_rust_backend_codec_for_tests(
                &source_path,
                &archive_path,
                ChdCodec::ZLIB,
                6,
                6,
            )
            .expect("create rust compressed chd");
        assert_chd_map_contains_self_copy(&archive_path);
        let map_payload_bytes = chd_v5_compressed_map_payload_bytes(&archive_path);
        assert!(
            map_payload_bytes < 512,
            "expected repeated-hunk map payload to be compact, got {map_payload_bytes} bytes"
        );

        handler
            .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_path, 6)
            .expect("extract rust compressed chd");
        let extracted = fs::read(&extracted_path).expect("read extracted output");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_compressed_create_round_trip_matches_source_payload() {
        let temp_dir = temp_dir_path("chd-rust-compressed-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let payload = (0..(896 * 1024))
            .map(|index| (index as u8).wrapping_mul(41))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = ChdContainerHandler;
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_raw_flac_payload_round_trip_matches_input_bytes() {
        let handler = ChdContainerHandler;
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

    fn build_cd_mode1_sector_for_ecc_test(seed: u8) -> [u8; 2352] {
        let mut sector = [0_u8; 2352];
        sector[..12].copy_from_slice(&[
            0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,
        ]);
        for (offset, byte) in sector[12..].iter_mut().enumerate() {
            *byte = seed.wrapping_add((offset as u8).wrapping_mul(13));
        }
        sector[0x0f] = 1;
        sector[0x81c..].fill(0);
        ChdContainerHandler::generate_cd_sector_ecc_for_tests(&mut sector);
        sector
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_cd_zlib_payload_marks_and_clears_reconstructable_ecc() {
        const SECTOR_BYTES: usize = 2352;
        const SUBCODE_BYTES: usize = 96;
        const ECC_P_OFFSET: usize = 0x81c;

        let handler = ChdContainerHandler;
        let valid_sector = build_cd_mode1_sector_for_ecc_test(17);
        let mut invalid_sector = build_cd_mode1_sector_for_ecc_test(41);
        invalid_sector[ECC_P_OFFSET] ^= 0x55;

        let sectors = [valid_sector, invalid_sector];
        let mut source = Vec::with_capacity(sectors.len() * (SECTOR_BYTES + SUBCODE_BYTES));
        let mut expected_subcode = Vec::with_capacity(sectors.len() * SUBCODE_BYTES);
        for (frame_index, sector) in sectors.iter().enumerate() {
            source.extend_from_slice(sector);
            for subcode_index in 0..SUBCODE_BYTES {
                let byte = ((frame_index * 37 + subcode_index * 11) % 251) as u8;
                source.push(byte);
                expected_subcode.push(byte);
            }
        }

        let encoded = handler
            .encode_cd_zlib_payload_for_tests(&source)
            .expect("encode cdzl payload");

        assert_eq!(encoded[0], 0b0000_0001);
        let compressed_sector_len = u16::from_be_bytes([encoded[1], encoded[2]]) as usize;
        let sector_stream_start = 3usize;
        let subcode_stream_start = sector_stream_start + compressed_sector_len;

        let mut sector_decoder =
            DeflateDecoder::new(&encoded[sector_stream_start..subcode_stream_start]);
        let mut decoded_sectors = Vec::new();
        sector_decoder
            .read_to_end(&mut decoded_sectors)
            .expect("decode cdzl sector stream");
        assert_eq!(decoded_sectors.len(), sectors.len() * SECTOR_BYTES);

        let valid_decoded = &decoded_sectors[..SECTOR_BYTES];
        assert!(valid_decoded[..12].iter().all(|byte| *byte == 0));
        assert!(valid_decoded[ECC_P_OFFSET..].iter().all(|byte| *byte == 0));
        assert_eq!(
            &valid_decoded[12..ECC_P_OFFSET],
            &valid_sector[12..ECC_P_OFFSET]
        );

        let invalid_decoded = &decoded_sectors[SECTOR_BYTES..SECTOR_BYTES * 2];
        assert_eq!(invalid_decoded, &invalid_sector);

        let mut subcode_decoder = DeflateDecoder::new(&encoded[subcode_stream_start..]);
        let mut decoded_subcode = Vec::new();
        subcode_decoder
            .read_to_end(&mut decoded_subcode)
            .expect("decode cdzl subcode stream");
        assert_eq!(decoded_subcode, expected_subcode);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_cd_flac_payload_round_trip_matches_input_bytes() {
        let handler = ChdContainerHandler;
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only multi codec chd");

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                        format: (if label == "dvd" { "chd-dvd" } else { "chd" }).to_string(),
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
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
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

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    format: "chd-dvd".to_string(),
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only dvd chd");
        let extracted = fs::read(output_dir.join("movie.iso")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    #[test]
    fn chd_rust_only_create_auto_infers_cd_iso_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-iso-auto-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_iso = temp_dir.join("disc.iso");
        let archive_path = temp_dir.join("disc.chd");
        let output_dir = temp_dir.join("out");
        let source_payload = (0..(2048 * 208))
            .map(|index| (index as u8).wrapping_mul(19))
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
            .expect("create rust-only cd chd from iso");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only cd chd");

        let cue = fs::read_to_string(output_dir.join("disc.cue")).expect("read cue");
        assert!(cue.contains("TRACK 01 MODE1/2048"));
        let extracted = fs::read(output_dir.join("disc.bin")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only cd chd");

        let extracted = fs::read(output_dir.join("disc.bin")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                    kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                    containing_archive: None,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only multi codec cd chd");

        let extracted = fs::read(output_dir.join("disc.bin")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
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
                        kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: true,
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

    // ----------------------------------------------------------------------------------------
    // Handler error-path coverage. These exercise malformed/truncated/wrong-magic inputs that
    // are otherwise only reached through the end-to-end cli_smoke suite, where a wrong or
    // missing guard surfaces as an opaque failure. Each asserts the matched `RomWeaverError`
    // variant and the specific guard message so the intended branch (not just *some* error) is
    // what fired.
    // ----------------------------------------------------------------------------------------

    /// A minimal but otherwise-valid 0x20-byte z3ds header. Individual fields are overridden by
    /// the malformed-header tests to land on a single guard at a time.
    fn build_z3ds_header(magic: [u8; 4], version: u16, header_size: u16) -> [u8; 0x20] {
        let mut raw = [0_u8; 0x20];
        raw[..4].copy_from_slice(&magic);
        // underlying_magic (offset 4..8) left zero
        raw[8..10].copy_from_slice(&version.to_le_bytes());
        raw[10..12].copy_from_slice(&header_size.to_le_bytes());
        // metadata_size (12..16), compressed_size (16..24), uncompressed_size (24..32) left zero
        raw
    }

    fn z3ds_probe_request(source: &Path) -> rom_weaver_core::ContainerProbeRequest {
        rom_weaver_core::ContainerProbeRequest {
            source: source.to_path_buf(),
            split_bin: false,
        }
    }

    #[test]
    fn z3ds_probe_rejects_truncated_header() {
        let temp_dir = temp_dir_path("z3ds-truncated-header");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("short.z3ds");
        // Fewer than the 0x20 header bytes -> read_exact hits UnexpectedEof.
        fs::write(&source, b"Z3DSshort").expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("truncated header should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("too small to be a z3ds container")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_probe_rejects_wrong_magic() {
        let temp_dir = temp_dir_path("z3ds-wrong-magic");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("bad-magic.z3ds");
        fs::write(&source, build_z3ds_header(*b"ZZZZ", 1, 0x20)).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("wrong magic should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("missing Z3DS magic")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_probe_rejects_unsupported_version() {
        let temp_dir = temp_dir_path("z3ds-bad-version");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("bad-version.z3ds");
        fs::write(&source, build_z3ds_header(*b"Z3DS", 2, 0x20)).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("unsupported version should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("unsupported z3ds version 2")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_probe_rejects_unsupported_header_size() {
        let temp_dir = temp_dir_path("z3ds-bad-header-size");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("bad-header-size.z3ds");
        fs::write(&source, build_z3ds_header(*b"Z3DS", 1, 0x40)).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("unsupported header size should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("unsupported z3ds header size 64")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_probe_rejects_metadata_size_past_eof() {
        let temp_dir = temp_dir_path("z3ds-metadata-overrun");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("metadata-overrun.z3ds");
        // Valid header, but metadata_size pushes the payload offset beyond the file size.
        let mut raw = build_z3ds_header(*b"Z3DS", 1, 0x20);
        raw[12..16].copy_from_slice(&4096_u32.to_le_bytes());
        fs::write(&source, raw).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("metadata size past EOF should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("invalid z3ds metadata size")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_probe_rejects_compressed_size_past_eof() {
        let temp_dir = temp_dir_path("z3ds-compressed-overrun");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("compressed-overrun.z3ds");
        // Valid header with no metadata, but compressed_size exceeds the bytes after the header.
        let mut raw = build_z3ds_header(*b"Z3DS", 1, 0x20);
        raw[16..24].copy_from_slice(&4096_u64.to_le_bytes());
        fs::write(&source, raw).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("compressed size past EOF should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("invalid z3ds compressed size")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_create_rejects_out_of_range_level() {
        let temp_dir = temp_dir_path("z3ds-bad-level");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.3ds");
        fs::write(&input_path, vec![0xAB; 4096]).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: temp_dir.join("disc.z3ds"),
                    format: "z3ds".to_string(),
                    codec: None,
                    level: Some(1000),
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("out-of-range level should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("z3ds level `1000` is out of range")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_create_rejects_unsupported_codec() {
        let temp_dir = temp_dir_path("z3ds-bad-codec");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.3ds");
        fs::write(&input_path, vec![0xAB; 4096]).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: temp_dir.join("disc.z3ds"),
                    format: "z3ds".to_string(),
                    codec: Some("lzma2".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("unsupported codec should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("unsupported z3ds codec `lzma2`")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_create_rejects_multiple_inputs() {
        let temp_dir = temp_dir_path("z3ds-multi-input");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let first = temp_dir.join("a.3ds");
        let second = temp_dir.join("b.3ds");
        fs::write(&first, vec![0x11; 16]).expect("fixture");
        fs::write(&second, vec![0x22; 16]).expect("fixture");

        let handler = Z3dsContainerHandler;
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![first, second],
                    output: temp_dir.join("disc.z3ds"),
                    format: "z3ds".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("multiple inputs should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("requires exactly one input file")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_probe_rejects_wrong_magic() {
        let temp_dir = temp_dir_path("cso-wrong-magic");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("not-really.cso");
        // Right size to be opened, wrong CISO header -> ciso reader construction fails.
        fs::write(&source, vec![0x00; 1024]).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("non-cso source should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("is invalid")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_create_is_rejected_with_extract_only_variant() {
        let temp_dir = temp_dir_path("cso-create-variant");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        fs::write(&input_path, b"payload").expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: temp_dir.join("payload.cso"),
                    format: "cso".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("cso create should be rejected");
        assert!(
            matches!(
                error,
                RomWeaverError::Unsupported(UnsupportedOp::ExtractOnlyCreate { ref format, .. })
                    if format == "cso"
            ),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_list_entries_normalizes_output_name() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let cases = [
            ("game.cso", "game.iso"),
            ("GAME.CISO", "GAME.iso"),
            ("disc.1.cso", "disc.iso"),
        ];
        for (input_name, expected) in cases {
            let entries = handler
                .list_entries(&z3ds_probe_request(Path::new(input_name)), &{
                    OperationContext::new(
                        ThreadBudget::Fixed(1),
                        test_temp_root(),
                        Arc::new(NoopProgressSink),
                        CancellationToken::new(),
                    )
                })
                .expect("cso list");
            assert_eq!(
                entries,
                vec![expected.to_string()],
                "for input {input_name}"
            );
        }
    }

    #[test]
    fn pbp_probe_rejects_truncated_source() {
        let temp_dir = temp_dir_path("pbp-truncated");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("short.pbp");
        // Below the 0x28-byte PBP header -> "too small" guard before any signature read.
        fs::write(&source, b"\0PBPshort").expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("truncated pbp should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("too small to be a pbp container")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_probe_rejects_invalid_first_section_offset() {
        let temp_dir = temp_dir_path("pbp-bad-section-offset");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("bad-section.pbp");
        // Valid magic + full header, but the first section offset (0x08) is below the header
        // size, tripping the section-table guard.
        let mut header = vec![0u8; 0x28];
        header[..4].copy_from_slice(&[0x00, b'P', b'B', b'P']);
        write_u32_le(&mut header, 8, 0x10); // first section offset < 0x28
        fs::write(&source, header).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("invalid section offset should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("invalid PBP section table")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_probe_rejects_out_of_range_psar_offset() {
        let temp_dir = temp_dir_path("pbp-bad-psar-offset");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("bad-psar.pbp");
        // The PSAR offset field (0x24) is the last section-table slot, so to reach the dedicated
        // PSAR guard (which rejects `>= file_size`) without first tripping the section-table guard
        // (which rejects `> file_size`) the value must equal the file size exactly. A 0x30-byte
        // file with the PSAR slot set to 0x30 passes the section checks but fails the PSAR check.
        let file_size = 0x30u32;
        let mut header = vec![0u8; file_size as usize];
        header[..4].copy_from_slice(&[0x00, b'P', b'B', b'P']);
        for section in 0..7 {
            write_u32_le(&mut header, 8 + (section * 4), 0x28);
        }
        write_u32_le(&mut header, 0x24, file_size); // PSAR offset == file size
        fs::write(&source, header).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let error = handler
            .probe_details(&z3ds_probe_request(&source), &test_context(&temp_dir, 1))
            .expect_err("out-of-range psar offset should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("invalid DATA.PSAR offset")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn nod_open_disc_rejects_non_disc_input() {
        let temp_dir = temp_dir_path("nod-open-bad");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source = temp_dir.join("not-a-disc.iso");
        // Random bytes are not a recognizable disc image -> nod open fails and is mapped to
        // a Validation error with the "failed to open" prefix.
        fs::write(&source, vec![0x5A; 4096]).expect("fixture");

        let core = NodHandlerCore::new(&GCZ, NodFormat::Gcz);
        // NodDiscReader is not Debug, so unwrap the error arm by hand rather than `expect_err`.
        let error = match core.open_disc(&source, 0) {
            Ok(_) => panic!("non-disc input should fail to open"),
            Err(error) => error,
        };
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("failed to open gcz source")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn nod_ensure_single_create_input_rejects_multiple_inputs() {
        let core = NodHandlerCore::new(&GCZ, NodFormat::Gcz);
        let request = ContainerCreateRequest {
            inputs: vec![PathBuf::from("a.iso"), PathBuf::from("b.iso")],
            output: PathBuf::from("out.rvz"),
            format: "gcz".to_string(),
            codec: None,
            level: None,
            parent: None,
        };
        let error = core
            .ensure_single_create_input(&request)
            .expect_err("multiple inputs should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("gcz create currently requires exactly one input file")),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn nod_validate_i8_level_rejects_overflowing_level() {
        let core = NodHandlerCore::new(&RVZ, NodFormat::Rvz);
        // Within i8 range round-trips unchanged.
        assert_eq!(core.validate_i8_level("zstd", 19).expect("in range"), 19);
        // Above i8::MAX (127) overflows the conversion guard.
        let error = core
            .validate_i8_level("zstd", 200)
            .expect_err("level 200 should overflow i8");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("level `200` is out of range")),
            "unexpected error: {error:?}"
        );
    }

    fn garbage_archive_bytes() -> Vec<u8> {
        // Deliberately not the magic of any container libarchive recognizes: a short run of
        // pseudo-random bytes. libarchive's format auto-detection rejects this, which the
        // containers-crate wrappers surface as a `Validation` error.
        (0..64u32)
            .map(|index| (index.wrapping_mul(37) ^ 0xA5) as u8)
            .collect()
    }

    #[test]
    fn libarchive_list_entries_wrapper_rejects_garbage_archive() {
        // libarchive's reader uses deep stack frames; mirror the other libarchive-backed tests
        // and run on an 8 MiB stack so the default 2 MiB test-thread stack does not overflow.
        run_with_large_stack("libarchive-list-garbage", || {
            let temp_dir = temp_dir_path("libarchive-list-garbage");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let source = temp_dir.join("garbage.7z");
            fs::write(&source, garbage_archive_bytes()).expect("fixture");

            let error = crate::list_regular_archive_entries_with_libarchive(&source, "7z")
                .expect_err("garbage archive should not list");
            assert!(
                matches!(error, RomWeaverError::Validation(_)),
                "unexpected error: {error:?}"
            );

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn libarchive_probe_details_wrapper_rejects_garbage_archive() {
        run_with_large_stack("libarchive-probe-garbage", || {
            let temp_dir = temp_dir_path("libarchive-probe-garbage");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let source = temp_dir.join("garbage.7z");
            fs::write(&source, garbage_archive_bytes()).expect("fixture");

            let error = crate::probe_regular_archive_details_with_libarchive(&source, "7z")
                .expect_err("garbage archive should not probe");
            assert!(
                matches!(error, RomWeaverError::Validation(_)),
                "unexpected error: {error:?}"
            );

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn libarchive_extract_wrapper_rejects_garbage_archive() {
        run_with_large_stack("libarchive-extract-garbage", || {
            let temp_dir = temp_dir_path("libarchive-extract-garbage");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let source = temp_dir.join("garbage.7z");
            fs::write(&source, garbage_archive_bytes()).expect("fixture");

            let request = rom_weaver_core::ContainerExtractRequest {
                source,
                out_dir: temp_dir.join("out"),
                selections: Vec::new(),
                kind_filter: rom_weaver_core::ArchiveEntryKindFilter::default(),
                containing_archive: None,
                split_bin: false,
                ignore_common_files: false,
                overwrite: true,
                parent: None,
            };
            let error = crate::extract_regular_archive_with_libarchive(
                &request,
                &test_context(&temp_dir, 1),
                "7z",
            )
            .expect_err("garbage archive should not extract");
            assert!(
                matches!(error, RomWeaverError::Validation(_)),
                "unexpected error: {error:?}"
            );

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn libarchive_stream_probe_wrapper_rejects_empty_payload() {
        run_with_large_stack("libarchive-stream-empty", || {
            let temp_dir = temp_dir_path("libarchive-stream-empty");
            fs::create_dir_all(&temp_dir).expect("temp dir");
            let source = temp_dir.join("empty.gz");
            // An empty file cannot be opened as a raw archive stream, so the wrapper surfaces a
            // `Validation` error carrying the format-name context it injected. (libarchive's raw
            // reader passes non-gzip *bytes* through the gzip filter rather than erroring, so a
            // truly empty input is the sound way to drive the open-stream failure path.)
            fs::write(&source, b"").expect("fixture");

            let error = crate::probe_stream_with_libarchive(
                &source,
                "gz",
                crate::LibarchiveReadFilter::Gzip,
            )
            .expect_err("empty payload should not stream-probe");
            assert!(
                matches!(error, RomWeaverError::Validation(ref message) if message.contains("gz probe failed")),
                "unexpected error: {error:?}"
            );

            let _ = fs::remove_dir_all(temp_dir);
        });
    }

    #[test]
    fn seven_z_parse_level_accepts_range_edges_and_rejects_below_range() {
        let temp_dir = temp_dir_path("seven-z-level-edges");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let execution = test_context(&temp_dir, 1).plan_threads(ThreadCapability::parallel(None));
        let handler = SevenZContainerHandler::new(&SEVEN_Z);

        // Both ends of the documented 0..=9 range are accepted.
        for level in [0, 9] {
            handler
                .parse_codec(Some("lzma2"), Some(level), &execution)
                .unwrap_or_else(|error| panic!("level {level} should parse: {error}"));
        }
        // Below the range is rejected by the same guard as the already-tested upper edge.
        let error = handler
            .parse_codec(Some("lzma2"), Some(-1), &execution)
            .expect_err("level -1 should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("out of range")),
            "unexpected error: {error:?}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }
}
