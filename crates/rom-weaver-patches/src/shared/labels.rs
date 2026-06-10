//! Shared label and report assembly helpers used by the patch format handlers. These keep the
//! human-readable report labels (and the byuu parse `details` JSON) byte-identical across the
//! formats that previously duplicated the same string assembly inline.

use rom_weaver_core::{FormatDescriptor, OperationReport};
use serde_json::json;

/// Append each warning to `label` as `"; warning=<text>"`, returning the combined label. The
/// warning texts themselves stay format-specific; only the join shape is shared.
pub(crate) fn append_warning_labels(mut label: String, warnings: &[String]) -> String {
    for warning in warnings {
        label.push_str("; warning=");
        label.push_str(warning);
    }
    label
}

/// Label suffix describing whether checksum validation ran: empty when it did, the shared
/// `"; checksum validation skipped"` marker when it was disabled.

/// Build the parse report shared by the byuu formats (BPS/UPS): identical label wording plus the
/// `patch` details JSON with the same keys, order, and types both handlers emitted inline.
pub(crate) fn byuu_parse_report(
    descriptor: &'static FormatDescriptor,
    record_count: usize,
    source_size: u64,
    target_size: u64,
    source_crc32: u32,
    target_crc32: u32,
    patch_crc32: u32,
) -> OperationReport {
    let mut report = crate::patch_success_report(
        descriptor,
        "parse",
        format!(
            "parsed {} patch with {record_count} record(s); source crc32 {source_crc32:08x}; target crc32 {target_crc32:08x}; patch crc32 {patch_crc32:08x}",
            descriptor.name
        ),
        None,
    );
    report.details = Some(json!({
        "patch": {
            "format": descriptor.name,
            "source_size": source_size,
            "target_size": target_size,
            "source_crc32": source_crc32,
            "target_crc32": target_crc32,
            "patch_crc32": patch_crc32,
            "record_count": record_count,
        }
    }));
    report
}
