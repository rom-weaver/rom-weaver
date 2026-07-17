//! Shared label and report assembly helpers used by the patch format handlers. These keep the
//! human-readable report labels (and the byuu parse `details` JSON) byte-identical across the
//! formats that previously duplicated the same string assembly inline.

use crate::shared::endpoints::{PatchEndpointSide, PatchEndpointVariant, attach_patch_endpoints};
use rom_weaver_core::{FormatDescriptor, OperationReport, ThreadExecution};
use serde_json::json;

/// The byuu (BPS/UPS) embedded expectations as one normalized endpoint
/// variant: exact source/target sizes plus whole-file CRC32s.
fn byuu_endpoint_variant(
    source_size: u64,
    target_size: u64,
    source_crc32: u32,
    target_crc32: u32,
) -> PatchEndpointVariant {
    PatchEndpointVariant::new(
        PatchEndpointSide::sized(source_size).with_checksum("crc32", format!("{source_crc32:08x}")),
        PatchEndpointSide::sized(target_size).with_checksum("crc32", format!("{target_crc32:08x}")),
    )
}

/// Build the create success report shared by record-based patch formats:
/// `"created <name> patch with <n> record(s)"`. Formats that append warning
/// labels or extra fields assemble their own report.
pub(crate) fn patch_create_report(
    descriptor: &'static FormatDescriptor,
    record_count: usize,
    execution: ThreadExecution,
) -> OperationReport {
    crate::patch_success_report(
        descriptor,
        "create",
        format!(
            "created {} patch with {record_count} record(s)",
            descriptor.name
        ),
        Some(execution),
    )
}

/// Append each warning to `label` as `"; warning=<text>"`, returning the combined label. The
/// warning texts themselves stay format-specific; only the join shape is shared.
pub(crate) fn append_warning_labels(mut label: String, warnings: &[String]) -> String {
    for warning in warnings {
        label.push_str("; warning=");
        label.push_str(warning);
    }
    label
}

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
    attach_patch_endpoints(
        &mut report,
        descriptor.name,
        vec![byuu_endpoint_variant(
            source_size,
            target_size,
            source_crc32,
            target_crc32,
        )],
    );
    report
}

/// Like [`byuu_parse_report`] but for the metadata-only ingest probe: the action stream was not
/// decoded, so `record_count` is omitted (reported as unknown) rather than zero. The embedded
/// source/target sizes + checksums still come straight from the header/footer.
pub(crate) fn byuu_metadata_report(
    descriptor: &'static FormatDescriptor,
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
            "described {} patch metadata; source crc32 {source_crc32:08x}; target crc32 {target_crc32:08x}; patch crc32 {patch_crc32:08x}",
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
        }
    }));
    attach_patch_endpoints(
        &mut report,
        descriptor.name,
        vec![byuu_endpoint_variant(
            source_size,
            target_size,
            source_crc32,
            target_crc32,
        )],
    );
    report
}
