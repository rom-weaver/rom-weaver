use super::*;

/// Builds the `probe` report shared by the libarchive-backed regular archive
/// handlers. Formats whose summary has a meaningful compressed size (zip, 7z)
/// pass `include_archive_bytes` so the message also reports it.
pub(crate) fn regular_archive_probe_report(
    request: &ContainerProbeRequest,
    format_name: &'static str,
    include_archive_bytes: bool,
) -> Result<OperationReport> {
    let summary = probe_regular_archive_details_with_libarchive(&request.source, format_name)?;
    let message = if include_archive_bytes {
        format!(
            "{}: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
            format_name,
            summary.entries_total,
            summary.files,
            summary.directories,
            summary.archive_bytes,
            summary.logical_bytes
        )
    } else {
        format!(
            "{}: {} entries ({} files, {} directories), {} bytes uncompressed",
            format_name,
            summary.entries_total,
            summary.files,
            summary.directories,
            summary.logical_bytes
        )
    };

    Ok(OperationReport::succeeded(
        OperationFamily::Container,
        Some(format_name.to_string()),
        "probe",
        message,
        Some(100.0),
        None,
    ))
}

/// Expands to the `list_entries`, `list_entry_records`, `read_entry_prefixes` and `extract` methods
/// of `ContainerHandlerOperations` for a handler with a `descriptor` field
/// whose archives libarchive reads.
///
/// The `($variant, $detailed)` form also generates `probe` (libarchive probe of
/// `LibarchiveProbeFormat::$variant`) and `probe_details`.
macro_rules! regular_archive_read_operations {
    ($variant:ident, $detailed:expr) => {
        fn probe(&self, source: &Path) -> ProbeConfidence {
            probe_regular_archive_with_libarchive(
                source,
                self.descriptor.name,
                LibarchiveProbeFormat::$variant,
            )
        }

        fn probe_details(
            &self,
            request: &ContainerProbeRequest,
            _context: &OperationContext,
        ) -> Result<OperationReport> {
            regular_archive_probe_report(request, self.descriptor.name, $detailed)
        }

        regular_archive_read_operations!();
    };
    () => {
        fn list_entries(
            &self,
            request: &ContainerProbeRequest,
            _context: &OperationContext,
        ) -> Result<Vec<String>> {
            list_regular_archive_entries_with_libarchive(&request.source, self.descriptor.name)
        }

        fn list_entry_records(
            &self,
            request: &ContainerProbeRequest,
            _context: &OperationContext,
        ) -> Result<Vec<ContainerListEntry>> {
            list_regular_archive_entry_records_with_libarchive(
                &request.source,
                self.descriptor.name,
            )
        }

        fn read_entry_prefixes(
            &self,
            request: &ContainerProbeRequest,
            entries: &[String],
            max_len: usize,
            _context: &OperationContext,
        ) -> Result<BTreeMap<String, Vec<u8>>> {
            read_regular_archive_entry_prefixes_with_libarchive(
                &request.source,
                self.descriptor.name,
                entries,
                max_len,
            )
        }

        fn extract(
            &self,
            request: &ContainerExtractRequest,
            context: &OperationContext,
        ) -> Result<OperationReport> {
            extract_regular_archive_with_libarchive(request, context, self.descriptor.name)
        }
    };
}

pub(crate) use regular_archive_read_operations;
