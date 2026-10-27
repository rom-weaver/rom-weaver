use lz4_flex::frame::{BlockMode, BlockSize, FrameEncoder, FrameInfo};
use rom_weaver_containers::ContainerRegistry;
use rom_weaver_core::{
    CancellationToken, ContainerExtractRequest, ContainerProbeRequest, NoopProgressSink,
    OperationContext, ProbeConfidence, ThreadBudget,
};
use std::{fs, io::Write, path::PathBuf, sync::Arc};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-lz4-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("scratch directory");
        Self(path)
    }

    fn context(&self) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(4),
            self.0.join("temp"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn request(&self, name: &str) -> ContainerExtractRequest {
        ContainerExtractRequest {
            source: self.0.join(name),
            out_dir: self.0.join("out"),
            selections: Vec::new(),
            kind_filter: Default::default(),
            containing_archive: None,
            split_bin: false,
            ignore_common_files: false,
            overwrite: true,
            parent: None,
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove scratch");
    }
}

fn frame(payload: &[u8], mode: BlockMode) -> Vec<u8> {
    let info = FrameInfo::new()
        .block_size(BlockSize::Max64KB)
        .block_mode(mode)
        .block_checksums(true)
        .content_checksum(true);
    let mut encoder = FrameEncoder::with_frame_info(info, Vec::new());
    encoder.write_all(payload).expect("encode fixture");
    encoder.finish().expect("finish fixture")
}

#[test]
fn lz4_stream_extracts_exact_payload() {
    let scratch = Scratch::new();
    let registry = ContainerRegistry::new();
    for size in [1, 4096, 262_145] {
        let payload: Vec<u8> = (0..size).map(|i| (i * 31 + (i >> 4)) as u8).collect();
        for mode in [BlockMode::Independent, BlockMode::Linked] {
            let request = scratch.request("original.bin.lz4");
            fs::write(&request.source, frame(&payload, mode)).expect("write fixture");
            let handler = registry
                .probe(&request.source)
                .expect("standard LZ4 frames must have a registered extraction handler");
            assert_eq!(handler.descriptor().name, "lz4");
            assert_eq!(handler.probe(&request.source), ProbeConfidence::Signature);
            let probe = ContainerProbeRequest {
                source: request.source.clone(),
                split_bin: false,
            };
            assert_eq!(
                handler.list_entries(&probe, &scratch.context()).unwrap(),
                ["original.bin"]
            );
            handler.probe_details(&probe, &scratch.context()).unwrap();
            handler.extract(&request, &scratch.context()).unwrap();
            assert_eq!(
                fs::read(request.out_dir.join("original.bin")).unwrap(),
                payload
            );

            let unnamed = scratch.0.join("renamed");
            fs::copy(&request.source, &unnamed).unwrap();
            assert_eq!(registry.probe(&unnamed).unwrap().descriptor().name, "lz4");
            assert!(!handler.capabilities().create);
            assert_eq!(
                handler.capabilities().extract_threads,
                rom_weaver_core::ThreadCapability::single_threaded()
            );
        }
    }
}

#[test]
fn lz4_wrapped_tar_extracts_its_rom() {
    let scratch = Scratch::new();
    let payload = b"ROM payload inside an LZ4-wrapped tar";
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(payload.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "game.bin", payload.as_slice())
        .unwrap();
    let request = scratch.request("game.tar.lz4");
    fs::write(
        &request.source,
        frame(&tar.into_inner().unwrap(), BlockMode::Independent),
    )
    .unwrap();
    ContainerRegistry::new()
        .find_by_name("tar")
        .unwrap()
        .extract(&request, &scratch.context())
        .unwrap();
    assert_eq!(fs::read(request.out_dir.join("game.bin")).unwrap(), payload);
}

#[test]
fn lz4_stream_rejects_invalid_and_corrupt_frames() {
    let scratch = Scratch::new();
    let handler = ContainerRegistry::new()
        .find_by_name("lz4")
        .expect("lz4 handler");
    let valid = frame(&[0x5a; 4096], BlockMode::Independent);
    let mut corrupt = valid.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    for bytes in [b"not an LZ4 frame".to_vec(), valid[..9].to_vec(), corrupt] {
        let request = scratch.request("invalid.bin.lz4");
        fs::write(&request.source, bytes).unwrap();
        let error = handler.extract(&request, &scratch.context()).unwrap_err();
        assert!(error.to_string().contains("lz4"), "{error}");
        assert!(!request.out_dir.join("invalid.bin").exists());
    }
}
