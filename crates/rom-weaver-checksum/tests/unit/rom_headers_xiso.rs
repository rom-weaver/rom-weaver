use crate::rom_headers::{
    KnownRomHeader, ROM_HEADER_SCAN_BYTES, detect_known_rom_header_from_prefix,
    detect_strippable_rom_header_from_prefix,
};

#[test]
fn xiso_descriptor_overrides_copier_header_heuristics() {
    let mut prefix = vec![0_u8; 0x10800];
    prefix[0x10000..0x10014].copy_from_slice(b"MICROSOFT*XBOX*MEDIA");
    prefix[0x107EC..0x10800].copy_from_slice(b"MICROSOFT*XBOX*MEDIA");
    for extension in [
        None,
        Some(".xiso"),
        Some(".ISO"),
        Some(".bin"),
        Some(".smc"),
    ] {
        assert_eq!(
            detect_known_rom_header_from_prefix(&prefix, extension),
            None,
            "XDVDFS volume descriptor must override a zero-filled system area"
        );
        assert_eq!(
            detect_strippable_rom_header_from_prefix(&prefix, 131072, extension),
            None
        );
        assert_eq!(
            detect_strippable_rom_header_from_prefix(&prefix, 131584, extension),
            None
        );
    }
    assert!(ROM_HEADER_SCAN_BYTES >= prefix.len());
}

#[test]
fn copier_headers_without_a_complete_xiso_descriptor_still_match() {
    for len in [512, 0x10013, 0x10014, 0x107FF, 0x10800] {
        let mut prefix = vec![0_u8; len];
        if len >= 0x10014 {
            prefix[0x10000..0x10014].copy_from_slice(b"MICROSOFT*XBOX*MEDIA");
        }
        let matched = detect_strippable_rom_header_from_prefix(&prefix, 131584, Some(".smc"))
            .expect("ordinary copier header");
        assert_eq!(matched.header, KnownRomHeader::SmcZero);
        assert_eq!(matched.stripped_bytes(), Some(512));
    }
}

#[test]
fn streamed_xiso_never_plans_a_headerless_variant() {
    let mut image = vec![0_u8; 131072];
    image[0x10000..0x10014].copy_from_slice(b"MICROSOFT*XBOX*MEDIA");
    image[0x107EC..0x10800].copy_from_slice(b"MICROSOFT*XBOX*MEDIA");
    for chunk_len in [1, 32768, 65537, 131072] {
        let algorithms = vec!["crc32".to_owned()];
        let mut engine = crate::variants::StreamingVariantChecksums::new(
            &algorithms,
            image.len() as u64,
            Some("disc.xiso"),
            1,
        )
        .expect("variant engine");
        for chunk in image.chunks(chunk_len) {
            engine.update(chunk).expect("update XISO stream");
            if let Some(plan) = engine.take_planned_variants() {
                assert_eq!(
                    plan.len(),
                    1,
                    "XISO system area must not plan a headerless variant"
                );
                assert_eq!(plan[0].0, "raw");
            }
        }
        let output = engine.finalize().expect("XISO variants");
        assert_eq!(output.rows.len(), 1);
        assert_eq!(output.rows[0].id, "raw");
        assert_eq!(
            output.rows[0].checksums["crc32"],
            format!("{:08x}", crc32fast::hash(&image))
        );
    }
}
