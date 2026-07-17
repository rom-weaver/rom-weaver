//! Normalized embedded-endpoint metadata. Handlers report the whole-file
//! input/output expectations baked into a patch (sizes + checksums) under
//! `details.patch.endpoints`, one entry per candidate pairing (RUP patches
//! carry several file variants). Per-block/window checks are NOT whole-file
//! identifiers and never appear here.

use rom_weaver_core::OperationReport;
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeMap;

/// One side (input or output) of a patch's embedded whole-file expectations.
#[derive(Debug, Default, Serialize)]
pub(crate) struct PatchEndpointSide {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Lower bound only (e.g. PMSR grows the source in place); never used for
    /// identity matching.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_size: Option<u64>,
    /// algorithm -> lowercase hex, algorithm names matching the checksum engine.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub checksums: BTreeMap<String, String>,
}

impl PatchEndpointSide {
    pub(crate) fn sized(size: u64) -> Self {
        Self {
            size: Some(size),
            ..Self::default()
        }
    }

    pub(crate) fn with_checksum(mut self, algorithm: &str, hex: String) -> Self {
        self.checksums.insert(algorithm.to_string(), hex);
        self
    }

    pub(crate) fn checksum(algorithm: &str, hex: String) -> Self {
        Self::default().with_checksum(algorithm, hex)
    }

    fn is_empty(&self) -> bool {
        self.size.is_none() && self.min_size.is_none() && self.checksums.is_empty()
    }
}

/// One candidate input→output pairing.
#[derive(Debug, Default, Serialize)]
pub(crate) struct PatchEndpointVariant {
    pub input: PatchEndpointSide,
    pub output: PatchEndpointSide,
}

impl PatchEndpointVariant {
    pub(crate) fn new(input: PatchEndpointSide, output: PatchEndpointSide) -> Self {
        Self { input, output }
    }
}

/// Attach `endpoints` under the report's `details.patch`, creating the
/// surrounding objects when the handler emitted none. Existing `patch` keys
/// (the byuu source/target fields) are left untouched. Variants with nothing
/// on either side are dropped; if none remain the report is unchanged.
pub(crate) fn attach_patch_endpoints(
    report: &mut OperationReport,
    format: &str,
    variants: Vec<PatchEndpointVariant>,
) {
    let variants: Vec<PatchEndpointVariant> = variants
        .into_iter()
        .filter(|variant| !(variant.input.is_empty() && variant.output.is_empty()))
        .collect();
    if variants.is_empty() {
        return;
    }
    let details = report
        .details
        .get_or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("patch report details are always a JSON object");
    let patch = details
        .entry("patch")
        .or_insert_with(|| json!({ "format": format }))
        .as_object_mut()
        .expect("patch report details.patch is always a JSON object");
    patch.insert(
        "endpoints".to_string(),
        serde_json::to_value(&variants).expect("endpoint variants serialize"),
    );
}
