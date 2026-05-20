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
use rom_weaver_core::{
    FormatDescriptor, OperationFamily, OperationReport, PatchHandler, Result, RomWeaverError,
    ThreadExecution,
};
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

pub(crate) fn patch_success_report(
    descriptor: &'static FormatDescriptor,
    stage: &'static str,
    label: impl Into<String>,
    thread_execution: Option<ThreadExecution>,
) -> OperationReport {
    OperationReport::succeeded(
        OperationFamily::Patch,
        Some(descriptor.name.to_string()),
        stage,
        label,
        Some(100.0),
        thread_execution,
    )
}

pub(crate) fn patch_parse_report_with(
    descriptor: &'static FormatDescriptor,
    build_label: impl FnOnce() -> Result<String>,
) -> Result<OperationReport> {
    let label = build_label()?;
    Ok(patch_success_report(descriptor, "parse", label, None))
}

pub(crate) fn map_file_read_only(path: &Path) -> Result<Vec<u8>> {
    Ok(fs::read(path)?)
}

pub(crate) fn map_file_read_only_with_fallback(path: &Path) -> Result<Vec<u8>> {
    map_file_read_only(path)
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
#[path = "../tests/unit/lib.rs"]
mod tests;
