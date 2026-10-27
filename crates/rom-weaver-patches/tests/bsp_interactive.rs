use std::{fs, path::PathBuf, sync::Arc};

use rom_weaver_core::{
    CancellationToken, NoopProgressSink, OperationContext, PatchApplyRequest, PatchValidateRequest,
    ThreadBudget,
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
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            self.0.join("scratch"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
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
    assert!(
        error
            .to_string()
            .contains("interactive BSP menus are not supported"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&input).expect("input"), [0]);
}
