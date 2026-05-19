use std::{fs, path::Path};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, Result, RomWeaverError, ThreadCapability,
};

#[cfg(test)]
const BSP_VM_SOURCE: &str = include_str!("bsp_vm_runtime.js");

pub struct BspPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl BspPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for BspPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch_len = fs::metadata(patch_path)?.len();
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch script ({} byte(s)); semantic validation occurs during apply",
                self.descriptor.name, patch_len
            ),
            Some(100.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch_bytes = fs::read(patch_path)?;
        let input_bytes = fs::read(&request.input)?;

        let output_bytes = apply_bsp_patch_bytes(patch_bytes, input_bytes)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &output_bytes)?;

        let written = output_bytes.len();
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch script and wrote {} byte(s)",
                self.descriptor.name, written
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Unsupported(
            "BSP patch creation is not implemented; use an upstream BSP compiler".into(),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

fn apply_bsp_patch_bytes(patch_bytes: Vec<u8>, input_bytes: Vec<u8>) -> Result<Vec<u8>> {
    crate::bsp_native_vm::apply_bsp_patch_bytes_native(patch_bytes, input_bytes)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command};

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};
    use serde_json::Value;

    use super::{BSP_VM_SOURCE, BspPatchHandler, apply_bsp_patch_bytes};
    use crate::{
        BSP,
        test_support::{TestDir, test_context_with_threads},
    };

    struct ReferenceVector {
        name: &'static str,
        patch_hex: &'static str,
        input_hex: &'static str,
    }

    enum ReferenceOutcome {
        Success(Vec<u8>),
        Failure(i64),
        Error(String),
    }

    const REFERENCE_VECTORS: &[ReferenceVector] = &[
        ReferenceVector {
            name: "noop_exit",
            patch_hex: "0600000000",
            input_hex: "010203",
        },
        ReferenceVector {
            name: "writebyte_seek",
            patch_hex: "600100000018ff0600000000",
            input_hex: "010203",
        },
        ReferenceVector {
            name: "fillbyte_seekend",
            patch_hex: "66000000007002000000aa0600000000",
            input_hex: "010203",
        },
        ReferenceVector {
            name: "writedata_label",
            patch_hex: "60000000007c1300000004000000060000000010203040",
            input_hex: "00000000",
        },
        ReferenceVector {
            name: "xordata_mask",
            patch_hex: "60000000006c13000000030000000600000000ff0ff0",
            input_hex: "102030",
        },
        ReferenceVector {
            name: "lock_unlock_truncatepos",
            patch_hex: "60010000008018aa620100000018bb8118cc820600000000",
            input_hex: "0102030405",
        },
        ReferenceVector {
            name: "conditional_ifeq",
            patch_hex: "840005000000500005000000150000000602000000600000000018770600000000",
            input_hex: "010203",
        },
        ReferenceVector {
            name: "call_return",
            patch_hex: "040a00000006000000006000000000185501",
            input_hex: "010203",
        },
        ReferenceVector {
            name: "stack_push_pop",
            patch_hex: "081200000008340000000a000a015000340000001d00000006030000005001120000002c0000000604000000600000000018990600000000",
            input_hex: "010203",
        },
        ReferenceVector {
            name: "nonzero_exit",
            patch_hex: "0601000000",
            input_hex: "010203",
        },
    ];

    fn decode_hex(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0, "hex fixtures must have even length");
        (0..hex.len())
            .step_by(2)
            .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).expect("valid hex"))
            .collect()
    }

    fn encode_hex(bytes: &[u8]) -> String {
        let mut encoded = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            encoded.push_str(&format!("{byte:02x}"));
        }
        encoded
    }

    fn run_reference_patcher(
        runtime_path: &Path,
        patch_bytes: &[u8],
        input_bytes: &[u8],
    ) -> ReferenceOutcome {
        let reference_script = r#"
const fs = require("node:fs");
const vm = require("node:vm");
const runtimePath = process.env.BSP_RUNTIME;
const patchHex = process.env.PATCH_HEX;
const inputHex = process.env.INPUT_HEX;
const js = fs.readFileSync(runtimePath, "utf8");
const ctx = { setTimeout };
vm.createContext(ctx);
vm.runInContext(js, ctx);
const patch = Buffer.from(patchHex, "hex");
const input = Buffer.from(inputHex, "hex");
const patchBuffer = patch.buffer.slice(patch.byteOffset, patch.byteOffset + patch.byteLength);
const inputBuffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
const patcher = new ctx.BSPPatcher(patchBuffer, inputBuffer);
patcher.print = function (_message) { patcher.run(); };
patcher.menu = function (_options) { patcher.run(0); };
patcher.success = function (out) {
  const output = Buffer.from(new Uint8Array(out)).toString("hex");
  process.stdout.write(JSON.stringify({ state: 4, out: output }));
};
patcher.failure = function (code) {
  process.stdout.write(JSON.stringify({ state: 3, code: Number(code) }));
};
patcher.error = function (error) {
  process.stdout.write(JSON.stringify({ state: 2, error: String(error) }));
};
patcher.run();
"#;

        let output = Command::new("node")
            .arg("-e")
            .arg(reference_script)
            .env("BSP_RUNTIME", runtime_path.as_os_str())
            .env("PATCH_HEX", encode_hex(patch_bytes))
            .env("INPUT_HEX", encode_hex(input_bytes))
            .output()
            .expect("failed to execute Node.js reference runtime");

        assert!(
            output.status.success(),
            "reference runtime failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let parsed: Value = serde_json::from_slice(&output.stdout).expect("reference json output");
        let state = parsed["state"].as_i64().expect("state should be a number");
        match state {
            4 => {
                let out_hex = parsed["out"].as_str().expect("output hex string");
                ReferenceOutcome::Success(decode_hex(out_hex))
            }
            3 => ReferenceOutcome::Failure(parsed["code"].as_i64().expect("failure code")),
            2 => ReferenceOutcome::Error(
                parsed["error"]
                    .as_str()
                    .expect("reference error")
                    .to_string(),
            ),
            other => panic!("unexpected reference state {other}"),
        }
    }

    #[test]
    fn parse_reports_patch_size() {
        let temp = TestDir::new();
        let patch_path = temp.child("update.bsp");
        fs::write(&patch_path, [0x06, 0x00, 0x00, 0x00, 0x00]).expect("fixture");

        let handler = BspPatchHandler::new(&BSP);
        let report = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect("parse report");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert_eq!(report.stage, "parse");
        assert_eq!(report.format.as_deref(), Some("BSP"));
        assert!(report.label.contains("5 byte(s)"));
    }

    #[test]
    fn apply_executes_patch_script() {
        let temp = TestDir::new();
        let input_path = temp.child("source.bin");
        let patch_path = temp.child("update.bsp");
        let output_path = temp.child("output.bin");

        fs::write(&input_path, [0x01, 0x02, 0x03]).expect("fixture");
        fs::write(&patch_path, [0x18, 0xFF, 0x06, 0x00, 0x00, 0x00, 0x00]).expect("fixture");

        let handler = BspPatchHandler::new(&BSP);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("apply");

        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert_eq!(
            fs::read(output_path).expect("output"),
            vec![0xFF, 0x02, 0x03]
        );
    }

    #[test]
    fn apply_surfaces_non_zero_exit_status() {
        let temp = TestDir::new();
        let input_path = temp.child("source.bin");
        let patch_path = temp.child("exit1.bsp");
        let output_path = temp.child("output.bin");

        fs::write(&input_path, [0x01, 0x02, 0x03]).expect("fixture");
        fs::write(&patch_path, [0x06, 0x01, 0x00, 0x00, 0x00]).expect("fixture");

        let handler = BspPatchHandler::new(&BSP);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect_err("non-zero exit should fail");

        assert!(
            error
                .to_string()
                .contains("BSP patch script exited with failure status 1")
        );
    }

    #[test]
    fn apply_matches_reference_runtime_vectors() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping BSP reference parity test because Node.js is unavailable");
            return;
        }

        let temp = TestDir::new();
        let runtime_path = temp.child("reference_bsppatch.js");
        fs::write(&runtime_path, BSP_VM_SOURCE).expect("reference runtime fixture");

        for vector in REFERENCE_VECTORS {
            let patch_bytes = decode_hex(vector.patch_hex);
            let input_bytes = decode_hex(vector.input_hex);
            let reference = run_reference_patcher(&runtime_path, &patch_bytes, &input_bytes);
            let ours = apply_bsp_patch_bytes(patch_bytes.clone(), input_bytes.clone());

            match reference {
                ReferenceOutcome::Success(expected_output) => {
                    let actual_output = ours.expect("BSP apply should succeed");
                    assert_eq!(
                        actual_output, expected_output,
                        "BSP parity mismatch for case `{}`",
                        vector.name
                    );
                }
                ReferenceOutcome::Failure(code) => {
                    let error = ours.expect_err("BSP apply should fail");
                    assert!(
                        error.to_string().contains(&format!(
                            "BSP patch script exited with failure status {code}"
                        )),
                        "BSP parity mismatch for case `{}`: expected failure code {}, got {}",
                        vector.name,
                        code,
                        error
                    );
                }
                ReferenceOutcome::Error(reference_error) => {
                    let error = ours.expect_err("BSP apply should error");
                    assert!(
                        error.to_string().contains(&reference_error),
                        "BSP parity mismatch for case `{}`: expected runtime error containing `{}`, got `{}`",
                        vector.name,
                        reference_error,
                        error
                    );
                }
            }
        }
    }

    #[test]
    fn apply_matches_reference_runtime_menu_selection() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping BSP reference parity test because Node.js is unavailable");
            return;
        }

        let temp = TestDir::new();
        let runtime_path = temp.child("reference_bsppatch.js");
        fs::write(&runtime_path, BSP_VM_SOURCE).expect("reference runtime fixture");

        fn push_word(buffer: &mut Vec<u8>, value: u32) {
            buffer.extend_from_slice(&value.to_le_bytes());
        }

        let mut patch = Vec::new();
        patch.push(0x60); // seek 0
        push_word(&mut patch, 0);
        patch.push(0x6a); // menu v0, table
        patch.push(0x00);
        push_word(&mut patch, 64);
        patch.push(0x54); // ifne v0, 0, alt
        patch.push(0x00);
        push_word(&mut patch, 0);
        push_word(&mut patch, 31);
        patch.push(0x18); // writebyte 'A'
        patch.push(0x41);
        patch.push(0x06); // exit 0
        push_word(&mut patch, 0);
        patch.push(0x18); // alt: writebyte 'B'
        patch.push(0x42);
        patch.push(0x06); // exit 0
        push_word(&mut patch, 0);

        while patch.len() < 64 {
            patch.push(0);
        }
        push_word(&mut patch, 80);
        push_word(&mut patch, 82);
        push_word(&mut patch, 0xFFFF_FFFF);
        while patch.len() < 80 {
            patch.push(0);
        }
        patch.extend_from_slice(b"A\0B\0");

        let input = vec![0x00];
        let reference = run_reference_patcher(&runtime_path, &patch, &input);
        let ours = apply_bsp_patch_bytes(patch, input).expect("native apply");
        let expected = match reference {
            ReferenceOutcome::Success(bytes) => bytes,
            ReferenceOutcome::Failure(code) => panic!("reference failed with status {code}"),
            ReferenceOutcome::Error(error) => panic!("reference errored: {error}"),
        };

        assert_eq!(ours, expected, "menu selection parity mismatch");
        assert_eq!(ours, vec![0x41]);
    }

    #[test]
    fn create_is_reported_as_unsupported() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.bsp");
        fs::write(&original_path, [0x01, 0x02]).expect("fixture");
        fs::write(&modified_path, [0x03, 0x04]).expect("fixture");

        let handler = BspPatchHandler::new(&BSP);
        let error = handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_path,
                    format: "BSP".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("create should be unsupported");

        assert!(
            error
                .to_string()
                .contains("BSP patch creation is not implemented")
        );
    }
}
