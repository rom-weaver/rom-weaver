use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, Result,
};
use std::path::Path;

pub struct Ninja1PatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl Ninja1PatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn unsupported_report(&self, stage: &'static str) -> OperationReport {
        OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            stage,
            "recognized NINJA1 patch header, but this variant is not currently supported (NINJA2/RUP is supported)",
            None,
        )
    }
}

impl PatchHandler for Ninja1PatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn parse(&self, _patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        Ok(self.unsupported_report("parse"))
    }

    fn apply(
        &self,
        _request: &PatchApplyRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(self.unsupported_report("apply"))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(self.unsupported_report("create"))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: false,
            apply: false,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: false,
        }
    }
}
