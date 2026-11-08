use std::{
    fs,
    path::PathBuf,
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

use rom_weaver_core::{
    CancellationToken, NoopProgressSink, OperationContext, PatchApplyRequest, PatchValidateRequest,
    RomWeaverErrorKind, ThreadBudget,
};
use rom_weaver_patches::PatchRegistry;

const INTERACTIVE_MENU_HEX: &str = "60000000006a00400000005400000000001c000000184106000000001842060000000000000000000000000000000000000000000000000000000000000000005000000052000000ffffffff0000000041004200";

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-bsp-menu-{}-{}",
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
        self.context_with_cancel(threads, CancellationToken::new())
    }

    fn context_with_cancel(&self, threads: usize, cancel: CancellationToken) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            self.0.join("scratch"),
            Arc::new(NoopProgressSink),
            cancel,
        )
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove scratch directory");
    }
}

fn interactive_menu_patch() -> Vec<u8> {
    (0..INTERACTIVE_MENU_HEX.len())
        .step_by(2)
        .map(|offset| {
            u8::from_str_radix(&INTERACTIVE_MENU_HEX[offset..offset + 2], 16).expect("hex fixture")
        })
        .collect()
}

#[test]
fn interactive_bsp_menu_is_rejected_without_output() {
    let temp = Scratch::new();
    let input = temp.0.join("menu-input.bin");
    let patch_path = temp.0.join("interactive-menu.bsp");
    let output = temp.0.join("output.bin");
    fs::write(&input, [0]).expect("input");
    let handler = PatchRegistry::new().find_by_name("BSP").expect("BSP");

    fs::write(&patch_path, interactive_menu_patch()).expect("patch");
    for threads in [1, 2] {
        let result = handler.apply(
            &PatchApplyRequest {
                input: input.clone(),
                patches: vec![patch_path.clone()],
                output: output.clone(),
            },
            &temp.context(threads),
        );
        let error = result.expect_err("interactive BSP menus must not silently select a branch");
        assert_eq!(error.kind(), RomWeaverErrorKind::Unsupported);
        assert!(
            error
                .to_string()
                .contains("interactive BSP menus are not supported"),
            "unexpected error: {error}"
        );
        assert!(
            !output.exists(),
            "rejected BSP must not leave an output file"
        );
        assert_eq!(fs::read(&input).expect("input"), [0]);
    }
}

#[test]
fn validate_rejects_interactive_bsp_menu_without_changing_input() {
    let temp = Scratch::new();
    let input = temp.0.join("menu-input.bin");
    let patch = temp.0.join("interactive-menu.bsp");
    fs::write(&input, [0]).expect("input");
    fs::write(&patch, interactive_menu_patch()).expect("patch");

    let error = PatchRegistry::new()
        .find_by_name("BSP")
        .expect("BSP")
        .validate(
            &PatchValidateRequest {
                input: input.clone(),
                patches: vec![patch],
            },
            &temp.context(1),
        )
        .expect_err("interactive BSP menus must fail validation");
    assert_eq!(error.kind(), RomWeaverErrorKind::Unsupported);
    assert!(
        error
            .to_string()
            .contains("interactive BSP menus are not supported"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&input).expect("input"), [0]);
}

/// `print "first"; bufstring "two"; bufchar '!'; printbuf; print "first"; exit 0`, with the
/// three NUL-terminated strings placed right after the 26 bytes of code.
fn printing_patch() -> Vec<u8> {
    let mut patch = Vec::new();
    patch.push(0x68); // print
    patch.extend_from_slice(&26u32.to_le_bytes());
    patch.push(0xA0); // bufstring
    patch.extend_from_slice(&32u32.to_le_bytes());
    patch.push(0xA2); // bufchar
    patch.extend_from_slice(&u32::from(b'!').to_le_bytes());
    patch.push(0xA6); // printbuf
    patch.push(0x68); // print
    patch.extend_from_slice(&36u32.to_le_bytes());
    patch.push(0x06); // exit
    patch.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(patch.len(), 26);
    patch.extend_from_slice(b"first\0two\0first\0");
    patch
}

#[test]
fn printed_messages_reach_the_apply_report_in_order() {
    let temp = Scratch::new();
    let input = temp.0.join("print-input.bin");
    let patch_path = temp.0.join("print.bsp");
    fs::write(&input, [7]).expect("input");
    fs::write(&patch_path, printing_patch()).expect("patch");
    let handler = PatchRegistry::new().find_by_name("BSP").expect("BSP");

    for threads in [1, 2] {
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input.clone(),
                    patches: vec![patch_path.clone()],
                    output: temp.0.join(format!("print-output-{threads}.bin")),
                },
                &temp.context(threads),
            )
            .expect("a printing script applies");
        assert!(
            report
                .label
                .ends_with(
                    "; warning=BSP message 1: first; warning=BSP message 2: two!; warning=BSP message 3: first"
                ),
            "messages must be listed in print order: {}",
            report.label
        );
    }
}

#[test]
fn cancellation_stops_a_runaway_script_within_a_bounded_time() {
    let temp = Scratch::new();
    let input = temp.0.join("loop-input.bin");
    let patch_path = temp.0.join("loop.bsp");
    let output = temp.0.join("loop-output.bin");
    fs::write(&input, [0]).expect("input");
    // `jump 0`: loops until the step budget (billions of steps) would trip.
    let mut patch = vec![0x02];
    patch.extend_from_slice(&0u32.to_le_bytes());
    fs::write(&patch_path, patch).expect("patch");
    let handler = PatchRegistry::new().find_by_name("BSP").expect("BSP");

    let cancel = CancellationToken::new();
    let canceller = {
        let cancel = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancel.cancel();
        })
    };
    let started = Instant::now();
    let error = handler
        .apply(
            &PatchApplyRequest {
                input,
                patches: vec![patch_path],
                output: output.clone(),
            },
            &temp.context_with_cancel(1, cancel),
        )
        .expect_err("a cancelled script must stop");
    canceller.join().expect("canceller thread");

    assert_eq!(error.kind(), RomWeaverErrorKind::Cancelled, "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "cancellation took {:?}",
        started.elapsed()
    );
    assert!(!output.exists(), "a cancelled BSP must not leave an output");
}

/// `print <addr>; jump 0` over a multi-MiB string with no cap-sized early exit: each print
/// scans the whole string, so only a poll inside the scan makes cancellation prompt.
#[test]
fn cancellation_interrupts_an_expensive_print_loop_promptly() {
    const STRING_BYTES: usize = 16 << 20;
    let temp = Scratch::new();
    let input = temp.0.join("print-loop-input.bin");
    let patch_path = temp.0.join("print-loop.bsp");
    let output = temp.0.join("print-loop-output.bin");
    fs::write(&input, [0]).expect("input");
    let mut patch = vec![0x68]; // print 10
    patch.extend_from_slice(&10u32.to_le_bytes());
    patch.push(0x02); // jump 0
    patch.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(patch.len(), 10);
    patch.resize(10 + STRING_BYTES, b'A');
    patch.push(0);
    fs::write(&patch_path, patch).expect("patch");

    let cancel = CancellationToken::new();
    let context = temp.context_with_cancel(1, cancel.clone());
    let (done_tx, done_rx) = mpsc::channel();
    let worker = {
        let (input, patch_path, output) = (input.clone(), patch_path.clone(), output.clone());
        thread::spawn(move || {
            let result = PatchRegistry::new()
                .find_by_name("BSP")
                .expect("BSP")
                .apply(
                    &PatchApplyRequest {
                        input,
                        patches: vec![patch_path],
                        output,
                    },
                    &context,
                );
            let _ = done_tx.send((Instant::now(), result));
        })
    };
    thread::sleep(Duration::from_millis(200));
    let cancelled_at = Instant::now();
    cancel.cancel();
    // Without the poll in the string scan this takes minutes: stop waiting instead of hanging.
    let (finished_at, result) = done_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("cancellation must interrupt the print loop within 10s");
    worker.join().expect("apply thread");

    let error = result.expect_err("a cancelled script must stop");
    assert_eq!(error.kind(), RomWeaverErrorKind::Cancelled, "{error}");
    assert!(
        finished_at.duration_since(cancelled_at) < Duration::from_secs(5),
        "cancellation took {:?}",
        finished_at.duration_since(cancelled_at)
    );
    assert!(!output.exists(), "a cancelled BSP must not leave an output");
}
