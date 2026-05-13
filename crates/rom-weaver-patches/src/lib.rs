use std::{path::Path, sync::Arc};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result,
};

const IPS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "IPS",
    aliases: &[],
    extensions: &[".ips"],
};
const BPS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "BPS",
    aliases: &[],
    extensions: &[".bps"],
};
const UPS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "UPS",
    aliases: &[],
    extensions: &[".ups"],
};
const VCDIFF: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "VCDIFF",
    aliases: &["vcdiff"],
    extensions: &[".vcdiff"],
};
const XDELTA: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "xdelta",
    aliases: &["xdelta3"],
    extensions: &[".xdelta"],
};
const APS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "APS",
    aliases: &[],
    extensions: &[".aps"],
};
const APSGBA: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "APSGBA",
    aliases: &["aps-gba"],
    extensions: &[".apsgba"],
};
const RUP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "RUP",
    aliases: &[],
    extensions: &[".rup"],
};
const PPF: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "PPF",
    aliases: &[],
    extensions: &[".ppf"],
};
const EBP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "EBP",
    aliases: &[],
    extensions: &[".ebp"],
};
const BDF_BSDIFF40: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "BDF/BSDIFF40",
    aliases: &["bdf", "bsdiff", "bsdiff40"],
    extensions: &[".bdf", ".bsdiff", ".bsdiff40"],
};
const PMSR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "PMSR",
    aliases: &[],
    extensions: &[".pmsr"],
};

pub struct PatchRegistry {
    handlers: Vec<Arc<dyn PatchHandler>>,
}

impl Default for PatchRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PatchRegistry {
    pub fn new() -> Self {
        Self {
            handlers: vec![
                Arc::new(StaticPatchHandler::new(&IPS)),
                Arc::new(StaticPatchHandler::new(&BPS)),
                Arc::new(StaticPatchHandler::new(&UPS)),
                Arc::new(StaticPatchHandler::new(&VCDIFF)),
                Arc::new(StaticPatchHandler::new(&XDELTA)),
                Arc::new(StaticPatchHandler::new(&APS)),
                Arc::new(StaticPatchHandler::new(&APSGBA)),
                Arc::new(StaticPatchHandler::new(&RUP)),
                Arc::new(StaticPatchHandler::new(&PPF)),
                Arc::new(StaticPatchHandler::new(&EBP)),
                Arc::new(StaticPatchHandler::new(&BDF_BSDIFF40)),
                Arc::new(StaticPatchHandler::new(&PMSR)),
            ],
        }
    }

    pub fn handlers(&self) -> &[Arc<dyn PatchHandler>] {
        &self.handlers
    }

    pub fn probe(&self, path: &Path) -> Option<Arc<dyn PatchHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_path(path))
            .cloned()
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn PatchHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_name(name))
            .cloned()
    }
}

struct StaticPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl StaticPatchHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn unsupported_label(&self, operation: &str) -> String {
        format!(
            "{operation} is not implemented yet for {}",
            self.descriptor.name
        )
    }
}

impl PatchHandler for StaticPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, _patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            self.unsupported_label("parse"),
            None,
        ))
    }

    fn apply(
        &self,
        _request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(rom_weaver_core::ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            self.unsupported_label("apply"),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(rom_weaver_core::ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            self.unsupported_label("create"),
            Some(execution),
        ))
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

#[cfg(test)]
mod tests {
    use super::PatchRegistry;

    #[test]
    fn registry_contains_planned_formats() {
        let registry = PatchRegistry::new();
        let names = registry
            .handlers()
            .iter()
            .map(|handler| handler.descriptor().name)
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "IPS",
                "BPS",
                "UPS",
                "VCDIFF",
                "xdelta",
                "APS",
                "APSGBA",
                "RUP",
                "PPF",
                "EBP",
                "BDF/BSDIFF40",
                "PMSR",
            ]
        );
    }
}
