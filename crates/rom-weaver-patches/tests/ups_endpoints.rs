use std::{fs, sync::Arc};

use rom_weaver_core::{
    CancellationToken, NoopProgressSink, OperationContext, PatchCreateRequest,
    PatchValidateRequest, ThreadBudget,
};
use rom_weaver_patches::PatchRegistry;
use serde_json::json;

#[test]
fn ups_metadata_exposes_both_strict_endpoints() {
    let context = OperationContext::new_with_private_temp_root(
        ThreadBudget::Fixed(1),
        &std::env::temp_dir(),
        "ups-endpoints",
        Arc::new(NoopProgressSink),
        CancellationToken::new(),
    );
    fs::create_dir_all(context.temp_root()).expect("temp directory");
    let original = context.temp_root().join("original.bin");
    let modified = context.temp_root().join("modified.bin");
    fs::write(&original, [0, 1, 2, 3]).expect("original");
    fs::write(&modified, [0, 1, 9, 3, 4, 5]).expect("modified");

    let registry = PatchRegistry::new();
    for (format, count) in [("UPS", 2), ("BPS", 1)] {
        let patch = context.temp_root().join(format!("change.{format}"));
        let handler = registry
            .handlers()
            .iter()
            .find(|handler| handler.descriptor().name == format)
            .expect("handler");
        handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified: modified.clone(),
                    output: patch.clone(),
                    format: format.into(),
                },
                &context,
            )
            .expect("create patch");
        if format == "UPS" {
            handler
                .validate(
                    &PatchValidateRequest {
                        input: modified.clone(),
                        patches: vec![patch.clone()],
                    },
                    &context,
                )
                .expect("strict reverse validation");
        }
        let report = handler
            .describe_metadata(&patch, &context)
            .expect("metadata");
        let endpoints = report.details.as_ref().expect("details")["patch"]["endpoints"]
            .as_array()
            .expect("endpoints");
        assert_eq!(
            endpoints.len(),
            count,
            "UPS metadata must expose both input directions"
        );
        let forward = &endpoints[0];
        assert_eq!(
            forward["input"],
            json!({"size": 4, "checksums": {"crc32": "8bb98613"}})
        );
        assert_eq!(
            forward["output"],
            json!({"size": 6, "checksums": {"crc32": "e7ea484b"}})
        );
        if format == "UPS" {
            assert_eq!(
                forward["execution"],
                json!({"variant": 0, "direction": "forward"})
            );
            assert_eq!(endpoints[1]["input"], forward["output"]);
            assert_eq!(endpoints[1]["output"], forward["input"]);
            assert_eq!(
                endpoints[1]["execution"],
                json!({"variant": 0, "direction": "reverse"})
            );
        }
    }
}
