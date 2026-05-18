mod aps_n64;
mod apsgba;
mod bdf;
mod bps;
mod dldi;
mod dps;
mod ips;
mod pds;
mod pmsr;
mod ppf;
mod qbsdiff_support;
mod rup;
mod solid;
mod spatch;
#[cfg(test)]
mod test_support;
mod ups;
#[cfg(not(target_family = "wasm"))]
mod vcdiff;
#[cfg(not(target_family = "wasm"))]
mod xdelta_ffi;

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use aps_n64::ApsN64PatchHandler;
use apsgba::ApsGbaPatchHandler;
use bdf::BdfPatchHandler;
use bps::BpsPatchHandler;
use dldi::DldiPatchHandler;
use dps::DpsPatchHandler;
use ips::IpsPatchHandler;
use pds::PdsPatchHandler;
use pmsr::PmsrPatchHandler;
use ppf::PpfPatchHandler;
use rom_weaver_core::{FormatDescriptor, OperationFamily, PatchHandler, Result, RomWeaverError};
use rup::RupPatchHandler;
use solid::SolidPatchHandler;
use spatch::SpatchPatchHandler;
use ups::UpsPatchHandler;
#[cfg(not(target_family = "wasm"))]
use vcdiff::VcdiffPatchHandler;

const IPS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "IPS",
    aliases: &[],
    extensions: &[".ips"],
};
const IPS32: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "IPS32",
    aliases: &[],
    extensions: &[".ips32"],
};
const SPATCH: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "SPATCH",
    aliases: &["double-ips", "doubleips"],
    extensions: &[".spatch"],
};
const SOLID: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "SOLID",
    aliases: &["solidpatch", "solid-patch"],
    extensions: &[".solid"],
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
#[cfg(not(target_family = "wasm"))]
const VCDIFF: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "VCDIFF",
    aliases: &["vcdiff"],
    extensions: &[".vcdiff"],
};
#[cfg(not(target_family = "wasm"))]
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
const MOD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "MOD",
    aliases: &["pmsr"],
    extensions: &[".mod", ".pmsr"],
};
const DLDI: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "DLDI",
    aliases: &[],
    extensions: &[".dldi"],
};
const DPS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "DPS",
    aliases: &[],
    extensions: &[".dps"],
};
const PDS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "PDS",
    aliases: &[],
    extensions: &[".pds"],
};

const BPS_SIGNATURE: &[u8] = b"BPS1";
const UPS_SIGNATURE: &[u8] = b"UPS1";
#[cfg(not(target_family = "wasm"))]
const VCDIFF_SIGNATURE: [u8; 3] = [0xD6, 0xC3, 0xC4];
const APS_N64_SIGNATURE: &[u8] = b"APS10";
const APS_GBA_SIGNATURE: &[u8] = b"APS1";
const RUP_SIGNATURE: &[u8] = b"NINJA2";
const PPF1_SIGNATURE: &[u8] = b"PPF1";
const PPF2_SIGNATURE: &[u8] = b"PPF2";
const PPF3_SIGNATURE: &[u8] = b"PPF3";
const IPS_SIGNATURE: &[u8] = b"PATCH";
const IPS32_SIGNATURE: &[u8] = b"IPS32";
const SOLID_SIGNATURE: &[u8] = b"SP";
const MOD_SIGNATURE: &[u8] = b"PMSR";
const DLDI_SIGNATURE: [u8; 12] = [
    0xED, 0xA5, 0x8D, 0xBF, b' ', b'C', b'h', b'i', b's', b'h', b'm', 0x00,
];
const BSDIFF_SIGNATURE: &[u8] = b"BSDIFF40";

pub(crate) fn require_single_patch_file<'a>(
    patches: &'a [PathBuf],
    format_name: &str,
) -> Result<&'a PathBuf> {
    if patches.len() != 1 {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} apply expects exactly one patch file"
        )));
    }
    Ok(&patches[0])
}

pub(crate) struct CreatedPatchFile {
    pub(crate) bytes: Vec<u8>,
    pub(crate) record_count: usize,
}

impl CreatedPatchFile {
    pub(crate) fn new(bytes: Vec<u8>, record_count: usize) -> Self {
        Self {
            bytes,
            record_count,
        }
    }
}

pub(crate) fn finalize_single_threaded_patch_create(
    descriptor: &'static FormatDescriptor,
    request: &rom_weaver_core::PatchCreateRequest,
    context: &rom_weaver_core::OperationContext,
    created_patch: CreatedPatchFile,
) -> Result<rom_weaver_core::OperationReport> {
    let execution = context.plan_threads(rom_weaver_core::ThreadCapability::single_threaded());
    if let Some(parent) = request.output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&request.output, created_patch.bytes)?;

    Ok(rom_weaver_core::OperationReport::succeeded(
        OperationFamily::Patch,
        Some(descriptor.name.to_string()),
        "create",
        format!(
            "created {} patch with {} record(s)",
            descriptor.name, created_patch.record_count
        ),
        Some(100.0),
        Some(execution),
    ))
}

pub(crate) fn default_patch_capabilities() -> rom_weaver_core::PatchCapabilities {
    rom_weaver_core::PatchCapabilities {
        parse: true,
        apply: true,
        create: true,
        threaded_scan: false,
        threaded_diff: false,
        threaded_output: false,
    }
}

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
        let mut handlers: Vec<Arc<dyn PatchHandler>> = vec![
            Arc::new(IpsPatchHandler::new(&IPS)),
            Arc::new(IpsPatchHandler::new_ips32(&IPS32)),
            Arc::new(SpatchPatchHandler::new(&SPATCH)),
            Arc::new(SolidPatchHandler::new(&SOLID)),
            Arc::new(BpsPatchHandler::new(&BPS)),
            Arc::new(UpsPatchHandler::new(&UPS)),
        ];
        #[cfg(not(target_family = "wasm"))]
        {
            handlers.push(Arc::new(VcdiffPatchHandler::new(&VCDIFF)));
            handlers.push(Arc::new(VcdiffPatchHandler::new(&XDELTA)));
        }
        handlers.push(Arc::new(ApsN64PatchHandler::new(&APS)));
        handlers.push(Arc::new(ApsGbaPatchHandler::new(&APSGBA)));
        handlers.push(Arc::new(RupPatchHandler::new(&RUP)));
        handlers.push(Arc::new(PpfPatchHandler::new(&PPF)));
        handlers.push(Arc::new(IpsPatchHandler::new_ebp(&EBP)));
        handlers.push(Arc::new(BdfPatchHandler::new(&BDF_BSDIFF40)));
        handlers.push(Arc::new(PmsrPatchHandler::new(&MOD)));
        handlers.push(Arc::new(DldiPatchHandler::new(&DLDI)));
        handlers.push(Arc::new(DpsPatchHandler::new(&DPS)));
        handlers.push(Arc::new(PdsPatchHandler::new(&PDS)));
        Self { handlers }
    }

    pub fn handlers(&self) -> &[Arc<dyn PatchHandler>] {
        &self.handlers
    }

    pub fn probe(&self, path: &Path) -> Option<Arc<dyn PatchHandler>> {
        let ebp_extension = is_ebp_extension(path);
        #[cfg(not(target_family = "wasm"))]
        let xdelta_extension = is_xdelta_extension(path);

        #[cfg(target_family = "wasm")]
        let signature_match = self.probe_by_signature(path, ebp_extension);
        #[cfg(not(target_family = "wasm"))]
        let signature_match = self.probe_by_signature(path, ebp_extension, xdelta_extension);
        if let Some(signature_match) = signature_match {
            return Some(signature_match);
        }

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

    fn probe_ambiguous_ips_by_signature(&self, path: &Path) -> Option<Arc<dyn PatchHandler>> {
        let bytes = fs::read(path).ok()?;

        if bytes.starts_with(b"IPS32") {
            return self.find_by_name("ips32");
        }

        if spatch::is_double_ips_stream(&bytes) {
            return self.find_by_name("spatch");
        }

        None
    }

    fn probe_by_signature(
        &self,
        path: &Path,
        ebp_extension: bool,
        #[cfg(not(target_family = "wasm"))] xdelta_extension: bool,
    ) -> Option<Arc<dyn PatchHandler>> {
        let prefix = read_signature_prefix(path, DLDI_SIGNATURE.len())?;

        if prefix.starts_with(BPS_SIGNATURE) {
            return self.find_by_name("bps");
        }
        if prefix.starts_with(UPS_SIGNATURE) {
            return self.find_by_name("ups");
        }
        #[cfg(not(target_family = "wasm"))]
        if prefix.starts_with(&VCDIFF_SIGNATURE) {
            if xdelta_extension {
                return self.find_by_name("xdelta");
            }
            return self.find_by_name("vcdiff");
        }
        if prefix.starts_with(APS_N64_SIGNATURE) {
            return self.find_by_name("aps");
        }
        if prefix.starts_with(APS_GBA_SIGNATURE) {
            return self.find_by_name("apsgba");
        }
        if prefix.starts_with(RUP_SIGNATURE) {
            return self.find_by_name("rup");
        }
        if prefix.starts_with(PPF1_SIGNATURE)
            || prefix.starts_with(PPF2_SIGNATURE)
            || prefix.starts_with(PPF3_SIGNATURE)
        {
            return self.find_by_name("ppf");
        }
        if prefix.starts_with(IPS32_SIGNATURE) {
            return self.find_by_name("ips32");
        }
        if prefix.starts_with(IPS_SIGNATURE) {
            if let Some(resolved) = self.probe_ambiguous_ips_by_signature(path) {
                return Some(resolved);
            }
            if ebp_extension {
                return self.find_by_name("ebp");
            }
            return self.find_by_name("ips");
        }
        if prefix.starts_with(SOLID_SIGNATURE) {
            return self.find_by_name("solid");
        }
        if prefix.starts_with(MOD_SIGNATURE) {
            return self.find_by_name("mod");
        }
        if prefix.starts_with(&DLDI_SIGNATURE) {
            return self.find_by_name("dldi");
        }
        if prefix.starts_with(BSDIFF_SIGNATURE) {
            return self.find_by_name("bdf");
        }

        None
    }
}

fn is_ebp_extension(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".ebp"))
}

fn is_xdelta_extension(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".xdelta"))
}

fn read_signature_prefix(path: &Path, max_len: usize) -> Option<Vec<u8>> {
    let mut bytes = vec![0u8; max_len];
    let mut file = fs::File::open(path).ok()?;
    let read = file.read(&mut bytes).ok()?;
    bytes.truncate(read);
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::PatchRegistry;

    fn temp_file_path(label: &str) -> PathBuf {
        temp_file_path_with_extension(label, "ips")
    }

    fn temp_file_path_with_extension(label: &str, extension: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        env::temp_dir().join(format!(
            "rom-weaver-patches-probe-{label}-{}-{timestamp}.{extension}",
            std::process::id(),
        ))
    }

    #[test]
    fn registry_contains_planned_formats() {
        let registry = PatchRegistry::new();
        let names = registry
            .handlers()
            .iter()
            .map(|handler| handler.descriptor().name)
            .collect::<Vec<_>>();
        let mut expected = vec!["IPS", "IPS32", "SPATCH", "SOLID", "BPS", "UPS"];
        #[cfg(not(target_family = "wasm"))]
        {
            expected.extend(["VCDIFF", "xdelta"]);
        }
        expected.extend([
            "APS",
            "APSGBA",
            "RUP",
            "PPF",
            "EBP",
            "BDF/BSDIFF40",
            "MOD",
            "DLDI",
            "DPS",
            "PDS",
        ]);
        assert_eq!(names, expected);
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
    fn ebp_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("ebp").expect("ebp handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(capabilities.create);
    }

    #[test]
    fn pds_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("pds").expect("pds handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(capabilities.create);
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
    fn dps_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("dps").expect("dps handler");
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
    fn probe_prefers_aps_n64_signature_over_apsgba_extension() {
        let path = temp_file_path_with_extension("aps10-over-apsgba-ext", "apsgba");
        fs::write(&path, b"APS10\0\0\0\0").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("aps probe");
        assert_eq!(handler.descriptor().name, "APS");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_prefers_apsgba_signature_over_aps_extension() {
        let path = temp_file_path_with_extension("aps1-over-aps-ext", "aps");
        fs::write(&path, b"APS1\0\0\0\0").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("apsgba probe");
        assert_eq!(handler.descriptor().name, "APSGBA");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_spatch_extension_to_spatch_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.spatch"))
            .expect("spatch probe");
        assert_eq!(handler.descriptor().name, "SPATCH");
    }

    #[test]
    fn probe_routes_solid_extension_to_solid_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.solid"))
            .expect("solid probe");
        assert_eq!(handler.descriptor().name, "SOLID");
    }

    #[test]
    fn probe_routes_ips32_extension_to_ips32_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.ips32"))
            .expect("ips32 probe");
        assert_eq!(handler.descriptor().name, "IPS32");
    }

    #[test]
    fn probe_routes_ips_extension_with_ips32_signature_to_ips32_handler() {
        let path = temp_file_path("ips32-magic");
        fs::write(&path, b"IPS32EEOF").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("ips32 probe");
        assert_eq!(handler.descriptor().name, "IPS32");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_ips_extension_with_double_ips_signature_to_spatch_handler() {
        let path = temp_file_path("double-ips");
        fs::write(&path, b"PATCHEOFPATCHEOF").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("spatch probe");
        assert_eq!(handler.descriptor().name, "SPATCH");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_ips_extension_with_single_ips_signature_to_ips_handler() {
        let path = temp_file_path("single-ips");
        fs::write(&path, b"PATCHEOF").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("ips probe");
        assert_eq!(handler.descriptor().name, "IPS");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_unknown_extension_with_bps_signature_to_bps_handler() {
        let path = temp_file_path_with_extension("bps-signature", "bin");
        fs::write(&path, b"BPS1\0\0\0\0").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("bps probe");
        assert_eq!(handler.descriptor().name, "BPS");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_unknown_extension_with_double_ips_signature_to_spatch_handler() {
        let path = temp_file_path_with_extension("double-ips-signature", "bin");
        fs::write(&path, b"PATCHEOFPATCHEOF").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("spatch probe");
        assert_eq!(handler.descriptor().name, "SPATCH");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_uses_ebp_extension_for_ambiguous_patch_signature() {
        let path = temp_file_path_with_extension("patch-signature-ebp", "ebp");
        fs::write(&path, b"PATCHEOF").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("ebp probe");
        assert_eq!(handler.descriptor().name, "EBP");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_pds_extension_to_pds_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.pds")).expect("pds probe");
        assert_eq!(handler.descriptor().name, "PDS");
    }

    #[test]
    fn probe_routes_dps_extension_to_dps_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.dps")).expect("dps probe");
        assert_eq!(handler.descriptor().name, "DPS");
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
    fn probe_does_not_route_bspatch_extensions() {
        let registry = PatchRegistry::new();
        for path in ["update.bspatch", "update.bspatch40"] {
            assert!(registry.probe(Path::new(path)).is_none());
        }
    }

    #[test]
    fn find_by_name_does_not_route_bspatch_aliases() {
        let registry = PatchRegistry::new();
        for alias in ["bspatch", "bspatch40"] {
            assert!(registry.find_by_name(alias).is_none());
        }
    }

    #[test]
    fn find_by_name_routes_pmsr_alias_to_mod_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("pmsr").expect("pmsr alias");
        assert_eq!(handler.descriptor().name, "MOD");
    }

    #[test]
    fn find_by_name_routes_dps_name_to_dps_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("dps").expect("dps name");
        assert_eq!(handler.descriptor().name, "DPS");
    }

    #[test]
    fn find_by_name_routes_dldi_name_to_dldi_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("dldi").expect("dldi name");
        assert_eq!(handler.descriptor().name, "DLDI");
    }

    #[test]
    fn find_by_name_routes_double_ips_alias_to_spatch_handler() {
        let registry = PatchRegistry::new();
        for alias in ["double-ips", "doubleips"] {
            let handler = registry.find_by_name(alias).expect("spatch alias");
            assert_eq!(handler.descriptor().name, "SPATCH");
        }
    }

    #[test]
    fn find_by_name_routes_solid_name_to_solid_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("solid").expect("solid name");
        assert_eq!(handler.descriptor().name, "SOLID");
    }

    #[test]
    fn find_by_name_routes_solid_aliases_to_solid_handler() {
        let registry = PatchRegistry::new();
        for alias in ["solidpatch", "solid-patch"] {
            let handler = registry.find_by_name(alias).expect("solid alias");
            assert_eq!(handler.descriptor().name, "SOLID");
        }
    }

    #[test]
    fn find_by_name_routes_ips32_name_to_ips32_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("ips32").expect("ips32");
        assert_eq!(handler.descriptor().name, "IPS32");
    }
}
