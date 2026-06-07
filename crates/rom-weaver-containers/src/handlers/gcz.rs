/* jscpd:ignore-start */
use super::*;

const GCZ_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&GCZ, NodFormat::Gcz);

pub(crate) struct GczContainerHandler;

impl ContainerHandlerOperations for GczContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &GCZ
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        GCZ_NOD_CORE.probe(source)
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        GCZ_NOD_CORE.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(GCZ_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        GCZ_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "warning: gcz compression is not supported; use `--format rvz` instead".into(),
        ))
    }
}
/* jscpd:ignore-end */
