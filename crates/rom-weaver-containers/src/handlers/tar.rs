/* jscpd:ignore-start */
use super::*;

#[derive(Clone, Copy, Debug)]
pub(crate) enum TarCompression {
    None,
    Gzip,
    Bzip2,
    Xz,
}

pub(crate) struct TarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl TarContainerHandler {
    pub(crate) const fn new(
        descriptor: &'static FormatDescriptor,
        _compression: TarCompression,
    ) -> Self {
        Self { descriptor }
    }
}

impl ContainerHandlerOperations for TarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        // Libarchive tar probing can succeed on arbitrary binary payloads.
        // Require a tar-family extension before treating tar probes as signature matches.
        if !self.descriptor.matches_path(source) {
            return ProbeConfidence::Extension;
        }
        probe_regular_archive_with_libarchive(
            source,
            self.descriptor.name,
            LibarchiveProbeFormat::Tar,
        )
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let summary =
            probe_regular_archive_details_with_libarchive(&request.source, self.descriptor.name)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "probe",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes uncompressed",
                self.descriptor.name,
                summary.entries_total,
                summary.files,
                summary.directories,
                summary.logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

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
        list_regular_archive_entry_records_with_libarchive(&request.source, self.descriptor.name)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        extract_regular_archive_with_libarchive(request, context, self.descriptor.name)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = (request, context);
        Err(extract_only_create_error(self.descriptor.name))
    }
}
/* jscpd:ignore-end */
