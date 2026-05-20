mod aps_n64;
mod apsgba;
mod bdf;
mod bps;
mod bsp;
mod bsp_native_vm;
mod dldi;
mod dps;
mod gdiff;
mod hdiffpatch;
mod ips;
mod ninja1;
mod pat;
mod pmsr;
mod ppf;
mod qbsdiff_support;
mod rup;
mod solid;
#[cfg(test)]
mod test_support;
mod ups;
mod vcdiff;

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
use bsp::BspPatchHandler;
use dldi::DldiPatchHandler;
use dps::DpsPatchHandler;
use gdiff::GdiffPatchHandler;
use hdiffpatch::HdiffPatchHandler;
use ips::IpsPatchHandler;
use ninja1::Ninja1PatchHandler;
use pat::{PatPatchHandler, has_pat_record_signature};
use pmsr::PmsrPatchHandler;
use ppf::PpfPatchHandler;
use rom_weaver_core::{FormatDescriptor, OperationFamily, PatchHandler, Result, RomWeaverError};
use rup::RupPatchHandler;
use solid::SolidPatchHandler;
use tracing::trace;
use ups::UpsPatchHandler;
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
const GDIFF: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "GDIFF",
    aliases: &["gdiff"],
    extensions: &[".gdiff", ".gdf"],
};
const HDIFFPATCH: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "HDiffPatch/HPatchZ",
    aliases: &["hdiffpatch", "hpatchz", "hdiff", "hpatch"],
    extensions: &[".hdiff", ".hpatchz"],
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
const NINJA1: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "NINJA1",
    aliases: &["ninja1"],
    extensions: &[],
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
const PAT: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "PAT",
    aliases: &["ffp", "fireflower"],
    extensions: &[".pat", ".ffp"],
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
const BSP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "BSP",
    aliases: &[],
    extensions: &[".bsp"],
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

const BPS_SIGNATURE: &[u8] = b"BPS1";
const UPS_SIGNATURE: &[u8] = b"UPS1";
const VCDIFF_SIGNATURE: [u8; 3] = [0xD6, 0xC3, 0xC4];
const GDIFF_SIGNATURE: [u8; 5] = [0xD1, 0xFF, 0xD1, 0xFF, 4];
const APS_N64_SIGNATURE: &[u8] = b"APS10";
const APS_GBA_SIGNATURE: &[u8] = b"APS1";
const NINJA1_SIGNATURE: &[u8] = b"NINJA1";
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
const HDIFF_SIGNATURE: &[u8] = b"HDIFF";
const PDS_UNSUPPORTED_REASON: &str =
    "PDS is explicitly unsupported because no surviving ecosystem patches are known";

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

pub fn explicitly_unsupported_patch_reason_for_name(name: &str) -> Option<&'static str> {
    if name.eq_ignore_ascii_case("pds") {
        return Some(PDS_UNSUPPORTED_REASON);
    }
    None
}

pub fn explicitly_unsupported_patch_reason_for_path(path: &Path) -> Option<&'static str> {
    let file_name = path.file_name().and_then(|value| value.to_str())?;
    if file_name.to_ascii_lowercase().ends_with(".pds") {
        return Some(PDS_UNSUPPORTED_REASON);
    }
    None
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
            Arc::new(SolidPatchHandler::new(&SOLID)),
            Arc::new(BpsPatchHandler::new(&BPS)),
            Arc::new(UpsPatchHandler::new(&UPS)),
        ];
        handlers.push(Arc::new(VcdiffPatchHandler::new(&VCDIFF)));
        handlers.push(Arc::new(VcdiffPatchHandler::new(&XDELTA)));
        handlers.push(Arc::new(GdiffPatchHandler::new(&GDIFF)));
        handlers.push(Arc::new(HdiffPatchHandler::new(&HDIFFPATCH)));
        handlers.push(Arc::new(ApsN64PatchHandler::new(&APS)));
        handlers.push(Arc::new(ApsGbaPatchHandler::new(&APSGBA)));
        handlers.push(Arc::new(Ninja1PatchHandler::new(&NINJA1)));
        handlers.push(Arc::new(RupPatchHandler::new(&RUP)));
        handlers.push(Arc::new(PpfPatchHandler::new(&PPF)));
        handlers.push(Arc::new(PatPatchHandler::new(&PAT)));
        handlers.push(Arc::new(IpsPatchHandler::new_ebp(&EBP)));
        handlers.push(Arc::new(BdfPatchHandler::new(&BDF_BSDIFF40)));
        handlers.push(Arc::new(BspPatchHandler::new(&BSP)));
        handlers.push(Arc::new(PmsrPatchHandler::new(&MOD)));
        handlers.push(Arc::new(DldiPatchHandler::new(&DLDI)));
        handlers.push(Arc::new(DpsPatchHandler::new(&DPS)));
        Self {
            handlers: handlers
                .into_iter()
                .map(rom_weaver_core::traced_patch_handler)
                .collect(),
        }
    }

    pub fn handlers(&self) -> &[Arc<dyn PatchHandler>] {
        &self.handlers
    }

    pub fn probe(&self, path: &Path) -> Option<Arc<dyn PatchHandler>> {
        let ebp_extension = is_ebp_extension(path);
        let xdelta_extension = is_xdelta_extension(path);
        trace!(
            patch = %path.display(),
            ebp_extension,
            xdelta_extension,
            "patch registry probe start"
        );
        let signature_match = self.probe_by_signature(path, ebp_extension, xdelta_extension);
        if let Some(signature_match) = signature_match {
            trace!(
                patch = %path.display(),
                format = signature_match.descriptor().name,
                "patch registry probe matched by signature"
            );
            return Some(signature_match);
        }

        let extension_match = self
            .handlers
            .iter()
            .find(|handler| handler.descriptor().matches_path(path))
            .cloned();
        if let Some(handler) = extension_match.as_ref() {
            trace!(
                patch = %path.display(),
                format = handler.descriptor().name,
                "patch registry probe matched by extension fallback"
            );
        } else {
            trace!(
                patch = %path.display(),
                "patch registry probe found no matching handler"
            );
        }
        extension_match
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn PatchHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_name(name))
            .cloned()
    }

    fn probe_ambiguous_ips_by_signature(&self, path: &Path) -> Option<Arc<dyn PatchHandler>> {
        let bytes = read_signature_prefix(path, 5)?;

        if bytes.starts_with(b"IPS32") {
            return self.find_by_name("ips32");
        }

        None
    }

    fn probe_by_signature(
        &self,
        path: &Path,
        ebp_extension: bool,
        xdelta_extension: bool,
    ) -> Option<Arc<dyn PatchHandler>> {
        let Some(prefix) = read_signature_prefix(path, DLDI_SIGNATURE.len()) else {
            trace!(
                patch = %path.display(),
                "patch signature probe skipped (unable to read signature bytes)"
            );
            return None;
        };

        if prefix.starts_with(BPS_SIGNATURE) {
            return self.probe_signature_match(path, "BPS1", "bps");
        }
        if prefix.starts_with(UPS_SIGNATURE) {
            return self.probe_signature_match(path, "UPS1", "ups");
        }
        if prefix.starts_with(&VCDIFF_SIGNATURE) {
            if xdelta_extension {
                return self.probe_signature_match(path, "VCDIFF+xdelta extension", "xdelta");
            }
            return self.probe_signature_match(path, "VCDIFF", "vcdiff");
        }
        if prefix.starts_with(&GDIFF_SIGNATURE) {
            return self.probe_signature_match(path, "GDIFF", "gdiff");
        }
        if prefix.starts_with(HDIFF_SIGNATURE) {
            return self.probe_signature_match(path, "HDIFF", "hdiffpatch");
        }
        if prefix.starts_with(APS_N64_SIGNATURE) {
            return self.probe_signature_match(path, "APS N64", "aps");
        }
        if prefix.starts_with(APS_GBA_SIGNATURE) {
            return self.probe_signature_match(path, "APS GBA", "apsgba");
        }
        if prefix.starts_with(NINJA1_SIGNATURE) {
            return self.probe_signature_match(path, "NINJA1", "ninja1");
        }
        if prefix.starts_with(RUP_SIGNATURE) {
            return self.probe_signature_match(path, "RUP", "rup");
        }
        if prefix.starts_with(PPF1_SIGNATURE)
            || prefix.starts_with(PPF2_SIGNATURE)
            || prefix.starts_with(PPF3_SIGNATURE)
        {
            return self.probe_signature_match(path, "PPF", "ppf");
        }
        if prefix.starts_with(IPS32_SIGNATURE) {
            return self.probe_signature_match(path, "IPS32", "ips32");
        }
        if prefix.starts_with(IPS_SIGNATURE) {
            if let Some(resolved) = self.probe_ambiguous_ips_by_signature(path) {
                trace!(
                    patch = %path.display(),
                    format = resolved.descriptor().name,
                    "patch signature probe resolved ambiguous IPS variant"
                );
                return Some(resolved);
            }
            if ebp_extension {
                return self.probe_signature_match(path, "IPS+ebp extension", "ebp");
            }
            return self.probe_signature_match(path, "IPS", "ips");
        }
        if prefix.starts_with(SOLID_SIGNATURE) {
            return self.probe_signature_match(path, "SOLID", "solid");
        }
        if prefix.starts_with(MOD_SIGNATURE) {
            return self.probe_signature_match(path, "PMSR/MOD", "mod");
        }
        if prefix.starts_with(&DLDI_SIGNATURE) {
            return self.probe_signature_match(path, "DLDI", "dldi");
        }
        if prefix.starts_with(BSDIFF_SIGNATURE) {
            return self.probe_signature_match(path, "BSDIFF40", "bdf");
        }
        if has_pat_record_signature(path) {
            return self.probe_signature_match(path, "PAT record", "pat");
        }

        trace!(
            patch = %path.display(),
            "patch signature probe found no signature match"
        );
        None
    }

    fn probe_signature_match(
        &self,
        path: &Path,
        signature: &'static str,
        handler_name: &'static str,
    ) -> Option<Arc<dyn PatchHandler>> {
        let handler = self.find_by_name(handler_name);
        if let Some(resolved) = handler.as_ref() {
            trace!(
                patch = %path.display(),
                signature = signature,
                format = resolved.descriptor().name,
                "patch signature probe matched"
            );
        } else {
            trace!(
                patch = %path.display(),
                signature = signature,
                handler = handler_name,
                "patch signature probe matched bytes but no handler was registered"
            );
        }
        handler
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
        let mut expected = vec!["IPS", "IPS32", "SOLID", "BPS", "UPS"];
        expected.extend(["VCDIFF", "xdelta", "GDIFF"]);
        expected.extend(["HDiffPatch/HPatchZ"]);
        expected.extend([
            "APS",
            "APSGBA",
            "NINJA1",
            "RUP",
            "PPF",
            "PAT",
            "EBP",
            "BDF/BSDIFF40",
            "MOD",
            "DLDI",
            "DPS",
        ]);
        expected.insert(
            expected.iter().position(|name| *name == "MOD").unwrap(),
            "BSP",
        );
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
    fn bsp_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("bsp").expect("bsp handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(!capabilities.create);
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
    fn pat_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("pat").expect("pat handler");
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
    fn gdiff_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("gdiff").expect("gdiff handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(capabilities.create);
    }

    #[test]
    fn hdiffpatch_is_wired_to_supported_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .find_by_name("hdiffpatch")
            .expect("hdiffpatch handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.parse);
        assert!(capabilities.apply);
        assert!(!capabilities.create);
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
    fn probe_routes_ips_extension_with_double_ips_signature_to_ips_handler() {
        let path = temp_file_path("double-ips");
        fs::write(&path, b"PATCHEOFPATCHEOF").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("ips probe");
        assert_eq!(handler.descriptor().name, "IPS");

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
    fn probe_routes_unknown_extension_with_ninja1_signature_to_ninja1_handler() {
        let path = temp_file_path_with_extension("ninja1-signature", "bin");
        fs::write(&path, b"NINJA1\0\0\0\0").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("ninja1 probe");
        assert_eq!(handler.descriptor().name, "NINJA1");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_unknown_extension_with_double_ips_signature_to_ips_handler() {
        let path = temp_file_path_with_extension("double-ips-signature", "bin");
        fs::write(&path, b"PATCHEOFPATCHEOF").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("ips probe");
        assert_eq!(handler.descriptor().name, "IPS");

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
    fn probe_routes_dps_extension_to_dps_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.dps")).expect("dps probe");
        assert_eq!(handler.descriptor().name, "DPS");
    }

    #[test]
    fn probe_routes_gdiff_extension_to_gdiff_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.gdiff"))
            .expect("gdiff probe");
        assert_eq!(handler.descriptor().name, "GDIFF");
    }

    #[test]
    fn probe_routes_hdiff_extension_to_hdiff_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.hdiff"))
            .expect("hdiff probe");
        assert_eq!(handler.descriptor().name, "HDiffPatch/HPatchZ");
    }

    #[test]
    fn probe_routes_hpatchz_extension_to_hdiff_handler() {
        let registry = PatchRegistry::new();
        let handler = registry
            .probe(Path::new("update.hpatchz"))
            .expect("hpatchz probe");
        assert_eq!(handler.descriptor().name, "HDiffPatch/HPatchZ");
    }

    #[test]
    fn probe_routes_pat_extension_to_pat_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.pat")).expect("pat probe");
        assert_eq!(handler.descriptor().name, "PAT");
    }

    #[test]
    fn probe_routes_ffp_extension_to_pat_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.ffp")).expect("ffp probe");
        assert_eq!(handler.descriptor().name, "PAT");
    }

    #[test]
    fn probe_routes_unknown_extension_with_pat_content_to_pat_handler() {
        let path = temp_file_path_with_extension("pat-signature", "txt");
        fs::write(&path, b"comment\n00000000 61 41\n").expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("pat probe");
        assert_eq!(handler.descriptor().name, "PAT");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_unknown_extension_with_gdiff_signature_to_gdiff_handler() {
        let path = temp_file_path_with_extension("gdiff-signature", "bin");
        fs::write(&path, [0xD1, 0xFF, 0xD1, 0xFF, 4, 0]).expect("fixture");

        let registry = PatchRegistry::new();
        let handler = registry.probe(&path).expect("gdiff probe");
        assert_eq!(handler.descriptor().name, "GDIFF");

        let _ = fs::remove_file(path);
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
    fn probe_routes_bsp_extension_to_bsp_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.probe(Path::new("update.bsp")).expect("bsp probe");
        assert_eq!(handler.descriptor().name, "BSP");
    }

    #[test]
    fn probe_does_not_route_bspatch_extensions() {
        let registry = PatchRegistry::new();
        for path in ["update.bspatch", "update.bspatch40"] {
            assert!(registry.probe(Path::new(path)).is_none());
        }
    }

    #[test]
    fn probe_does_not_route_pds_extensions() {
        let registry = PatchRegistry::new();
        for path in ["update.pds", "update.PDS"] {
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
    fn find_by_name_does_not_route_pds_name() {
        let registry = PatchRegistry::new();
        assert!(registry.find_by_name("pds").is_none());
        assert!(registry.find_by_name("PDS").is_none());
    }

    #[test]
    fn unsupported_reason_reports_pds_name_and_path() {
        assert_eq!(
            super::explicitly_unsupported_patch_reason_for_name("pds"),
            Some(super::PDS_UNSUPPORTED_REASON)
        );
        assert_eq!(
            super::explicitly_unsupported_patch_reason_for_name("PDS"),
            Some(super::PDS_UNSUPPORTED_REASON)
        );
        assert_eq!(
            super::explicitly_unsupported_patch_reason_for_path(Path::new("update.pds")),
            Some(super::PDS_UNSUPPORTED_REASON)
        );
        assert_eq!(
            super::explicitly_unsupported_patch_reason_for_path(Path::new("update.PDS")),
            Some(super::PDS_UNSUPPORTED_REASON)
        );
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
    fn find_by_name_routes_gdiff_name_to_gdiff_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("gdiff").expect("gdiff name");
        assert_eq!(handler.descriptor().name, "GDIFF");
    }

    #[test]
    fn find_by_name_routes_hdiff_aliases_to_hdiff_handler() {
        let registry = PatchRegistry::new();
        for alias in ["hdiffpatch", "hpatchz", "hdiff", "hpatch"] {
            let handler = registry.find_by_name(alias).expect("hdiff alias");
            assert_eq!(handler.descriptor().name, "HDiffPatch/HPatchZ");
        }
    }

    #[test]
    fn find_by_name_routes_bsp_name_to_bsp_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("bsp").expect("bsp name");
        assert_eq!(handler.descriptor().name, "BSP");
    }

    #[test]
    fn find_by_name_routes_pat_aliases_to_pat_handler() {
        let registry = PatchRegistry::new();
        for alias in ["pat", "ffp", "fireflower"] {
            let handler = registry.find_by_name(alias).expect("pat alias");
            assert_eq!(handler.descriptor().name, "PAT");
        }
    }

    #[test]
    fn find_by_name_routes_dldi_name_to_dldi_handler() {
        let registry = PatchRegistry::new();
        let handler = registry.find_by_name("dldi").expect("dldi name");
        assert_eq!(handler.descriptor().name, "DLDI");
    }

    #[test]
    fn find_by_name_does_not_route_double_ips_aliases() {
        let registry = PatchRegistry::new();
        for alias in ["double-ips", "doubleips"] {
            assert!(registry.find_by_name(alias).is_none());
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
