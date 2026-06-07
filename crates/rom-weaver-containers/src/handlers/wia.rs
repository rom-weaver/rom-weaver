/* jscpd:ignore-start */
use super::*;

const WIA_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&WIA, NodFormat::Wia);

pub(crate) struct WiaContainerHandler;

impl ContainerHandlerOperations for WiaContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WIA
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        WIA_NOD_CORE.probe(source)
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WIA_NOD_CORE.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(WIA_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WIA_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = (request, context);
        Err(RomWeaverError::Unsupported(format!(
            "{} is extract-only; supported create formats are 7z, zip, chd, rvz, and z3ds",
            WIA.name
        )))
    }
}
/* jscpd:ignore-end */
