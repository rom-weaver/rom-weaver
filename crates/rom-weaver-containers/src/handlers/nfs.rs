/* jscpd:ignore-start */
use super::*;

const NFS_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&NFS, NodFormat::Nfs);

pub(crate) struct NfsContainerHandler;

impl ContainerHandlerOperations for NfsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &NFS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        NFS_NOD_CORE.probe(source)
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        NFS_NOD_CORE.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(NFS_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        NFS_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "nfs compression is not supported; nfs can only be decompressed with `extract`".into(),
        ))
    }
}
/* jscpd:ignore-end */
