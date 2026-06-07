/* jscpd:ignore-start */
use super::*;

const TGC_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&TGC, NodFormat::Tgc);

pub(crate) struct TgcContainerHandler;

impl ContainerHandlerOperations for TgcContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &TGC
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        TGC_NOD_CORE.probe(source)
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        TGC_NOD_CORE.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(TGC_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        TGC_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = (request, context);
        Err(RomWeaverError::Unsupported(format!(
            "{} is extract-only; supported create formats are 7z, zip, chd, rvz, and z3ds",
            TGC.name
        )))
    }
}
/* jscpd:ignore-end */
