#![no_main]
use libfuzzer_sys::fuzz_target;
use rom_weaver_core::{
    CancellationToken, NoopProgressSink, OperationContext, OperationStatus, PatchApplyRequest,
    ThreadBudget,
};
use rom_weaver_patches::PatchRegistry;
use std::{fs, path::PathBuf, sync::Arc};

fuzz_target!(|data: &[u8]| {
    if data.is_empty() || data.len() > 4096 {
        return;
    }
    // Offsets MUST stay bounded so successful sparse IPS output cannot exhaust disk.
    // The independent interpreter models literal/RLE records, including overlaps.
    let mut expected = vec![0x5a; 64];
    let mut patch = b"PATCH".to_vec();
    for record in data[1..].chunks(4).take(64) {
        if record.len() < 4 {
            break;
        }
        let offset = usize::from(record[0]);
        let len = usize::from(record[1] % 32 + 1);
        patch.extend_from_slice(&[0, 0, record[0]]);
        if record[2] & 1 == 0 {
            patch.extend_from_slice(&(len as u16).to_be_bytes());
            patch.extend(std::iter::repeat_n(record[3], len));
        } else {
            patch.extend_from_slice(&[0, 0]);
            patch.extend_from_slice(&(len as u16).to_be_bytes());
            patch.push(record[3]);
        }
        expected.resize(expected.len().max(offset + len), 0);
        expected[offset..offset + len].fill(record[3]);
    }
    patch.extend_from_slice(b"EOF");
    let root = PathBuf::from(
        std::env::var_os("ROM_WEAVER_FUZZ_SCRATCH").expect("set ROM_WEAVER_FUZZ_SCRATCH"),
    );
    fs::create_dir_all(&root).unwrap();
    let input = root.join("input.bin");
    let patch_path = root.join("patch.ips");
    let output = root.join("output.bin");
    fs::write(&input, [0x5a; 64]).unwrap();
    fs::write(&patch_path, &patch).unwrap();
    let context = OperationContext::new(
        ThreadBudget::Fixed(1),
        root.join("temp"),
        Arc::new(NoopProgressSink),
        CancellationToken::default(),
    )
    .with_patch_apply_in_memory_limit(1024);
    let handler = PatchRegistry::default().find_by_name("ips").unwrap();
    let request = PatchApplyRequest {
        input,
        patches: vec![patch_path.clone()],
        output: output.clone(),
    };
    let report = handler
        .apply(&request, &context)
        .expect("structured IPS must apply");
    assert_eq!(report.status, OperationStatus::Succeeded);
    assert_eq!(fs::read(&output).unwrap(), expected);
    assert!(fs::metadata(&output).unwrap().len() <= 287);
    fs::remove_file(&output).unwrap();
    // Every proper prefix MUST fail, including truncation inside a record or EOF.
    fs::write(&patch_path, &patch[..usize::from(data[0]) % patch.len()]).unwrap();
    assert!(handler.apply(&request, &context).is_err());
});
