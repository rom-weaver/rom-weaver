use super::nod_shared::NodHandlerCore;
use super::*;

/// GameCube CISO shares the `CISO` magic and `.ciso` extension with PSP CSO. The 32-bit
/// little-endian value at bytes 4..8 tells them apart: PSP CSO stores its header size there (24,
/// or 0 from the original v1 tool) while GameCube CISO stores a sector-aligned block size.
const GC_CISO_SECTOR_SIZE: u32 = 0x8000;

/// Whether `header` (at least the first 8 bytes of a file) is a GameCube CISO header.
pub(crate) fn is_gamecube_ciso_header(header: &[u8]) -> bool {
    if header.len() < 8 || header[0..4] != CSO_SIGNATURE {
        return false;
    }
    let block_size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    block_size != 0 && block_size.is_multiple_of(GC_CISO_SECTOR_SIZE)
}

/// Whether the file at `source` is a GameCube CISO image rather than a PSP CSO.
pub(crate) fn is_gamecube_ciso_file(source: &Path) -> bool {
    let mut header = [0u8; 8];
    File::open(source)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && is_gamecube_ciso_header(&header)
}

const GC_CISO_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&GC_CISO, NodFormat::Ciso);

/// Extract-only GameCube CISO handler routed through the shared nod disc path.
pub(crate) struct GcCisoContainerHandler;

impl ContainerHandlerOperations for GcCisoContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &GC_CISO
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if is_gamecube_ciso_file(source) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        GC_CISO_NOD_CORE.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(GC_CISO_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        GC_CISO_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = (request, context);
        Err(extract_only_create_error(GC_CISO.name))
    }
}
