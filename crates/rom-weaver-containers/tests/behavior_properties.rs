use proptest::prelude::*;
use rom_weaver_containers::ContainerRegistry;
use rom_weaver_core::{
    CancellationToken, ContainerCreateRequest, ContainerExtractRequest, NoopProgressSink,
    OperationContext, ThreadBudget,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let parent = std::env::var_os("ROM_WEAVER_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .expect("current directory")
                    .join(".agent/container-properties")
            });
        let path = parent.join(format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("scratch directory");
        Self(path)
    }
    fn context(&self, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            self.0.join("temp"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove scratch");
    }
}
fn files(root: &Path, base: &Path, result: &mut BTreeMap<String, Vec<u8>>) {
    for entry in fs::read_dir(root).expect("list output") {
        let path = entry.expect("entry").path();
        assert!(!path.is_symlink(), "archives MUST not manufacture symlinks");
        if path.is_dir() {
            files(&path, base, result);
        } else {
            result.insert(
                path.strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                fs::read(path).expect("read output"),
            );
        }
    }
}
fn payload() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        Just(vec![]),
        any::<u8>().prop_map(|b| vec![b]),
        (
            any::<u8>(),
            prop::sample::select(vec![
                511, 512, 513, 4095, 4096, 4097, 8191, 8192, 8193, 65535, 65536, 65537, 131071,
                131072, 131073
            ])
        )
            .prop_map(|(b, n)| vec![b; n]),
        prop::collection::vec(any::<u8>(), 0..1024)
    ]
}
fn verify_archives(payloads: Vec<Vec<u8>>) -> Result<(), TestCaseError> {
    let scratch = Scratch::new();
    let mut inputs = Vec::new();
    let mut names = Vec::new();
    let mut expected = BTreeMap::new();
    for (i, bytes) in payloads.iter().enumerate() {
        let input = scratch.0.join(format!("source-{i}.bin"));
        fs::write(&input, bytes).unwrap();
        inputs.push(input);
        // Archive names MUST normalize separators and current-directory components.
        names.push(format!("./games\\group-{i}/./payload.bin"));
        expected.insert(format!("games/group-{i}/payload.bin"), bytes.clone());
    }
    for format in ["zip", "7z"] {
        let handler = ContainerRegistry::new()
            .find_by_name(format)
            .expect("archive handler");
        let mut first_archive_bytes = None;
        for threads in [1, 3] {
            let archive = scratch.0.join(format!("archive-{threads}.{format}"));
            handler
                .create(
                    &ContainerCreateRequest {
                        inputs: inputs.clone(),
                        archive_names: Some(names.clone()),
                        output: archive.clone(),
                        format: format.into(),
                        codec: Some(if format == "zip" { "store" } else { "lzma2" }.into()),
                        level: if format == "zip" { None } else { Some(0) },
                        parent: None,
                    },
                    &scratch.context(threads),
                )
                .expect("create archive");
            let encoded = fs::read(&archive).expect("read archive");
            if let Some(first) = &first_archive_bytes {
                prop_assert_eq!(&encoded, first, "thread budget changed {} bytes", format);
            } else {
                first_archive_bytes = Some(encoded);
            }
            let output = scratch.0.join(format!("output-{format}-{threads}"));
            handler
                .extract(
                    &ContainerExtractRequest {
                        source: archive,
                        out_dir: output.clone(),
                        selections: vec![],
                        kind_filter: Default::default(),
                        containing_archive: None,
                        split_bin: false,
                        ignore_common_files: false,
                        overwrite: false,
                        parent: None,
                    },
                    &scratch.context(threads),
                )
                .expect("extract archive");
            let mut actual = BTreeMap::new();
            files(&output, &output, &mut actual);
            prop_assert_eq!(&actual, &expected, "format={}, threads={}", format, threads);
        }
        for name in ["../escape.bin", "/escape.bin", "games/../../escape.bin"] {
            let result = handler.create(
                &ContainerCreateRequest {
                    inputs: vec![inputs[0].clone()],
                    archive_names: Some(vec![name.into()]),
                    output: scratch.0.join(format!("unsafe.{format}")),
                    format: format.into(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &scratch.context(1),
            );
            prop_assert!(result.is_err(), "unsafe archive name accepted: {}", name);
            prop_assert!(!scratch.0.join("escape.bin").exists());
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").map_or(32, |v|v.parse::<u32>().ok().filter(|n|*n>0).expect("positive PROPTEST_CASES")), ..ProptestConfig::default() })]
    #[test]
    fn archive_paths_and_bytes_survive_creation_and_extraction(payloads in prop::collection::vec(payload(),1..5)) {
        verify_archives(payloads)?;
    }
}

#[test]
fn explicit_archive_names_preserve_normalized_paths() {
    verify_archives(vec![vec![], vec![42]])
        .expect("explicit archive names MUST preserve normalized paths");
}
