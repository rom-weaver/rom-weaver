const GCZ_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&GCZ, NodFormat::Gcz);

struct GczContainerHandler;

impl ContainerHandler for GczContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &GCZ
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        GCZ_NOD_CORE.probe(source)
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        GCZ_NOD_CORE.inspect(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
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

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}
