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

fn assert_probe_for_fixture(
    path: PathBuf,
    fixture: &[u8],
    expected_handler_name: &str,
    probe_message: &str,
) {
    fs::write(&path, fixture).expect("fixture");

    let registry = PatchRegistry::new();
    let handler = registry.probe(&path).expect(probe_message);
    assert_eq!(handler.descriptor().name, expected_handler_name);

    let _ = fs::remove_file(path);
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
    assert_probe_for_fixture(path, b"PATCHEOFPATCHEOF", "IPS", "ips probe");
}

#[test]
fn probe_routes_ips_extension_with_single_ips_signature_to_ips_handler() {
    let path = temp_file_path("single-ips");
    assert_probe_for_fixture(path, b"PATCHEOF", "IPS", "ips probe");
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
    assert_probe_for_fixture(path, b"PATCHEOFPATCHEOF", "IPS", "ips probe");
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
