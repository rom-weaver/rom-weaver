use std::{fs, path::PathBuf, sync::Arc};

use proptest::prelude::*;
use rom_weaver_core::{
    CancellationToken, NoopProgressSink, OperationContext, PatchApplyRequest, PatchCreateRequest,
    ThreadBudget,
};
use rom_weaver_patches::PatchRegistry;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let root = std::env::var_os("XDG_CACHE_HOME").map_or_else(
            || {
                PathBuf::from(
                    std::env::var_os("HOME")
                        .or_else(|| std::env::var_os("USERPROFILE"))
                        .expect("HOME or USERPROFILE"),
                )
                .join(".cache")
            },
            PathBuf::from,
        );
        let path = root.join("agents/scratch/patch-properties").join(format!(
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

    fn context(&self, threads: usize, memory_limit: u64) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            self.0.join("scratch"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
        .with_patch_apply_in_memory_limit(memory_limit)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove scratch directory");
    }
}

fn edge_bytes() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        Just(vec![]),
        any::<u8>().prop_map(|byte| vec![byte]),
        (
            any::<u8>(),
            prop::sample::select(vec![2, 127, 128, 129, 255, 256, 257, 4095, 4096, 4097])
        )
            .prop_map(|(byte, size)| vec![byte; size]),
        prop::collection::vec(any::<u8>(), 0..512),
    ]
}

fn edge_pair() -> impl Strategy<Value = (Vec<u8>, Vec<u8>)> {
    prop_oneof![
        (edge_bytes(), edge_bytes()),
        (edge_bytes(), any::<u8>(), any::<bool>()).prop_map(|(source, byte, at_end)| {
            let mut target = source.clone();
            if target.is_empty() {
                target.push(byte);
            } else {
                let index = if at_end { target.len() - 1 } else { 0 };
                target[index] ^= byte | 1;
            }
            (source, target)
        }),
        (edge_bytes(), any::<u8>()).prop_map(|(source, byte)| {
            let mut target = source.clone();
            target.insert(target.len() / 2, byte);
            (source, target)
        }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").map_or(32, |value| value.parse::<u32>().ok().filter(|cases| *cases > 0).expect("positive PROPTEST_CASES")), ..ProptestConfig::default() })]

    #[test]
    fn patch_behavior_properties((source, target) in edge_pair()) {
        let temp = Scratch::new();
        let input = temp.0.join("source.bin");
        let modified = temp.0.join("target.bin");
        fs::write(&input, &source).expect("source");
        fs::write(&modified, &target).expect("target");
        let registry = PatchRegistry::new();
        for format in ["bps", "ups", "vcdiff", "gdiff", "bdf"] {
            let handler = registry.find_by_name(format).expect("handler");
            let patch = temp.0.join(format!("update.{format}"));
            handler.create(&PatchCreateRequest {
                original: input.clone(), modified: modified.clone(), output: patch.clone(), format: format.into(),
            }, &temp.context(1, 0)).expect("create");
            let serial_patch = fs::read(&patch).expect("serial patch");
            handler.create(&PatchCreateRequest {
                original: input.clone(), modified: modified.clone(), output: patch.clone(), format: format.into(),
            }, &temp.context(4, 0)).expect("parallel create");
            prop_assert_eq!(&serial_patch, &fs::read(&patch).expect("parallel patch"), "{} thread determinism", format);
            for (threads, limit) in [(1, 0), (4, 0), (1, u64::MAX)] {
                let output = temp.0.join(format!("output-{format}-{threads}-{limit}.bin"));
                handler.apply(&PatchApplyRequest {
                    input: input.clone(), patches: vec![patch.clone()], output: output.clone(),
                }, &temp.context(threads, limit)).expect("apply");
                prop_assert_eq!(&fs::read(output).expect("output"), &target, "{}: threads={}, memory_limit={}", format, threads, limit);
            }
            prop_assert_eq!(&fs::read(&input).expect("source after apply"), &source);
            prop_assert_eq!(&fs::read(&modified).expect("target after create"), &target);
        }
    }
}

#[test]
fn ups_scan_and_io_boundary_properties() {
    let registry = PatchRegistry::new();
    let handler = registry.find_by_name("ups").expect("UPS handler");
    for boundary in [64 * 1024, 4 * 1024 * 1024] {
        for len in [boundary - 1, boundary, boundary + 1] {
            let temp = Scratch::new();
            let input = temp.0.join("source.bin");
            let modified = temp.0.join("target.bin");
            let source = vec![0x42; len];
            let mut target = source.clone();
            for offset in [0, boundary.saturating_sub(1), boundary, len - 1] {
                if let Some(byte) = target.get_mut(offset) {
                    *byte = 0x24;
                }
            }
            fs::write(&input, &source).expect("source");
            fs::write(&modified, &target).expect("target");
            let mut serial_patch = None;
            for threads in [1, 4] {
                let patch = temp.0.join(format!("update-{threads}.ups"));
                handler
                    .create(
                        &PatchCreateRequest {
                            original: input.clone(),
                            modified: modified.clone(),
                            output: patch.clone(),
                            format: "ups".into(),
                        },
                        &temp.context(threads, 0),
                    )
                    .expect("create");
                let bytes = fs::read(&patch).expect("patch");
                if let Some(serial) = &serial_patch {
                    assert_eq!(&bytes, serial, "boundary={boundary}, len={len}");
                } else {
                    serial_patch = Some(bytes);
                }
                let output = temp.0.join(format!("output-{threads}.bin"));
                handler
                    .apply(
                        &PatchApplyRequest {
                            input: input.clone(),
                            patches: vec![patch],
                            output: output.clone(),
                        },
                        &temp.context(threads, 0),
                    )
                    .expect("apply");
                assert_eq!(fs::read(output).expect("output"), target);
            }
        }
    }
}
