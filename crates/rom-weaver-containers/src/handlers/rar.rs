use super::regular_archive::regular_archive_read_operations;
use super::*;

pub(crate) struct RarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl RarContainerHandler {
    pub(crate) const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl ContainerHandlerOperations for RarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    regular_archive_read_operations!(Rar, false);

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "rar create is not supported".into(),
        ))
    }
}
