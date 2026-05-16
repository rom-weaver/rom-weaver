mod apsgba;
mod bdf;
mod bps;
mod dldi;
mod ips;
mod pds;
mod pmsr;
mod ppf;
mod rup;
mod ups;
mod vcdiff;
mod xdelta_ffi;

use std::{path::Path, sync::Arc};

use apsgba::ApsGbaPatchHandler;
use bdf::BdfPatchHandler;
use bps::BpsPatchHandler;
use dldi::DldiPatchHandler;
use ips::IpsPatchHandler;
use pds::PdsPatchHandler;
use pmsr::PmsrPatchHandler;
use ppf::PpfPatchHandler;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result,
};
use rup::RupPatchHandler;
use ups::UpsPatchHandler;
use vcdiff::VcdiffPatchHandler;

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
    aliases: &["bdf", "bsdiff", "bsdiff40", "bspatch", "bspatch40"],
    extensions: &[".bdf", ".bsdiff", ".bsdiff40", ".bspatch", ".bspatch40"],
};
const MOD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "MOD",
    aliases: &["pmsr"],
    extensions: &[".mod", ".pmsr"],
};
const PDS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "PDS",
    aliases: &[],
    extensions: &[".pds"],
};
const DLDI: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "DLDI",
    aliases: &[],
    extensions: &[".dldi"],
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
                Arc::new(IpsPatchHandler::new(&IPS)),
                Arc::new(BpsPatchHandler::new(&BPS)),
                Arc::new(UpsPatchHandler::new(&UPS)),
                Arc::new(VcdiffPatchHandler::new(&VCDIFF)),
                Arc::new(VcdiffPatchHandler::new(&XDELTA)),
                Arc::new(ApsGbaPatchHandler::new(&APS)),
                Arc::new(ApsGbaPatchHandler::new(&APSGBA)),
                Arc::new(RupPatchHandler::new(&RUP)),
                Arc::new(PpfPatchHandler::new(&PPF)),
                Arc::new(StaticPatchHandler::new(&EBP)),
                Arc::new(BdfPatchHandler::new(&BDF_BSDIFF40)),
                Arc::new(PmsrPatchHandler::new(&MOD)),
                Arc::new(PdsPatchHandler::new(&PDS)),
                Arc::new(DldiPatchHandler::new(&DLDI)),
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
    use std::path::Path;

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
                "MOD",
                "PDS",
                "DLDI",
            ]
        );
    }

    #[test]
    fn aps_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("aps").expect("aps handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(capabilities.create);
    }

    #[test]
    fn bdf_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("bdf").expect("bdf handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(capabilities.create);
    }

    #[test]
    fn pds_is_wired_to_parse_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("pds").expect("pds handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(!capabilities.apply);
        assert!(!capabilities.create);
    }

    #[test]
    fn dldi_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("dldi").expect("dldi handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(capabilities.create);
    }

    #[test]
    fn probe_routes_aps_extension_to_aps_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.aps")).expect("aps probe");
        assert_eq!(handler.descriptor().name, "APS");
    }

    #[test]
    fn probe_routes_apsgba_extension_to_apsgba_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.apsgba"))
            .expect("apsgba probe");
        assert_eq!(handler.descriptor().name, "APSGBA");
    }

    #[test]
    fn probe_routes_pds_extension_to_pds_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.pds")).expect("pds probe");
        assert_eq!(handler.descriptor().name, "PDS");
    }

    #[test]
    fn probe_routes_dldi_extension_to_dldi_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.dldi"))
            .expect("dldi probe");
        assert_eq!(handler.descriptor().name, "DLDI");
    }

    #[test]
    fn probe_routes_mod_extension_to_mod_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.mod")).expect("mod probe");
        assert_eq!(handler.descriptor().name, "MOD");
    }

    #[test]
    fn probe_routes_bspatch_extensions_to_bsdiff_handler() {
        let registry = PatchRegistry::new();
        for path in ["update.bspatch", "update.bspatch40"] {
            let handler = registry.probe(Path::new(path)).expect("bspatch probe");
            assert_eq!(handler.descriptor().name, "BDF/BSDIFF40");
        }
    }

    #[test]
    fn find_by_name_routes_bspatch_aliases_to_bsdiff_handler() {
        let registry = PatchRegistry::new();
        for alias in ["bspatch", "bspatch40"] {
            let handler = registry.find_by_name(alias).expect("bspatch alias");
            assert_eq!(handler.descriptor().name, "BDF/BSDIFF40");
        }
    }

    #[test]
    fn find_by_name_routes_pmsr_alias_to_mod_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("pmsr").expect("pmsr alias");
        assert_eq!(handler.descriptor().name, "MOD");
    }
}
