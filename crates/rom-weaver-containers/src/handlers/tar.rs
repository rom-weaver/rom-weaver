use super::regular_archive::regular_archive_read_operations;
use super::*;

pub(crate) struct TarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl TarContainerHandler {
    pub(crate) const fn new(descriptor: &'static FormatDescriptor) -> Self {
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
        regular_archive_probe_report(request, self.descriptor.name, false)
    }

    regular_archive_read_operations!();

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = (request, context);
        Err(extract_only_create_error(self.descriptor.name))
    }
}
