/* jscpd:ignore-start */
use super::*;

const WBFS_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&WBFS, NodFormat::Wbfs);

pub(crate) struct WbfsContainerHandler;

impl ContainerHandlerOperations for WbfsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WBFS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        WBFS_NOD_CORE.probe(source)
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WBFS_NOD_CORE.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(WBFS_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WBFS_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = (request, context);
        Err(RomWeaverError::Unsupported(format!(
            "{} is extract-only; supported create formats are 7z, zip, chd, rvz, and z3ds",
            WBFS.name
        )))
    }
}
/* jscpd:ignore-end */
