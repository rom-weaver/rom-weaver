use crate::variants::StreamingVariantChecksums;

#[test]
fn streamed_gba_repair_hashes_the_complement_at_bd() {
    for len in [0xBD, 0xBE, 0xC0, 0x1BD, 0x1BE, 32768] {
        for chunk_len in [1, 189, 4099] {
            let mut rom = vec![0x31_u8; len];
            rom[4..0xA0].copy_from_slice(&crate::rom_headers::GBA_NINTENDO_LOGO);
            rom[0xB2] = 0x96;
            let mut expected = rom.clone();
            if len > 0xBD {
                // gbafix: https://github.com/devkitPro/gba-tools/blob/master/src/gbafix.c
                // A repaired complement MUST make the protected sum plus 0x19 equal zero.
                let sum: u32 = rom[0xA0..0xBD].iter().map(|b| u32::from(*b)).sum();
                expected[0xBD] = (0_u32.wrapping_sub(sum + 0x19) & 0xFF) as u8;
            }
            let algorithms = vec!["crc32".to_owned()];
            let mut engine =
                StreamingVariantChecksums::new(&algorithms, len as u64, Some("test.gba"), 1)
                    .expect("stream engine");
            for chunk in rom.chunks(chunk_len) {
                engine.update(chunk).expect("stream update");
            }
            let output = engine.finalize().expect("stream finalize");
            assert_eq!(
                output
                    .rows
                    .iter()
                    .find(|row| row.id == "raw")
                    .expect("raw")
                    .checksums["crc32"],
                format!("{:08x}", crc32fast::hash(&rom))
            );
            let repaired = output.rows.iter().find(|row| row.id == "fix-header");
            if len > 0xBD {
                assert_eq!(
                    repaired
                        .expect("GBA header-sized input must have a repair variant")
                        .checksums["crc32"],
                    format!("{:08x}", crc32fast::hash(&expected)),
                    "streamed GBA repair must change 0xBD only"
                );
                let mut healthy =
                    StreamingVariantChecksums::new(&algorithms, len as u64, Some("healthy.gba"), 1)
                        .expect("healthy engine");
                healthy.update(&expected).expect("healthy update");
                assert!(
                    !healthy
                        .finalize()
                        .expect("healthy finalize")
                        .rows
                        .iter()
                        .any(|row| row.id == "fix-header")
                );
            } else {
                assert!(
                    repaired.is_none(),
                    "truncated GBA header must not have a repair variant"
                );
            }
        }
    }
}

#[test]
fn streamed_gba_repair_requires_both_declared_and_available_header_bytes() {
    for (declared_len, available_len) in [(0xBD, 0xBE), (32768, 0xBD)] {
        let mut rom = vec![0x31_u8; available_len];
        rom[4..0xA0].copy_from_slice(&crate::rom_headers::GBA_NINTENDO_LOGO);
        rom[0xB2] = 0x96;
        let algorithms = vec!["crc32".to_owned()];
        let mut engine = StreamingVariantChecksums::new(
            &algorithms,
            declared_len,
            Some("changed-while-reading.gba"),
            1,
        )
        .expect("variant engine");
        engine.update(&rom).expect("partial or extended stream");
        let output = engine.finalize().expect("incomplete header stays raw");
        assert!(
            !output.rows.iter().any(|row| row.id == "fix-header"),
            "GBA repair requires both declared and available header bytes"
        );
    }
}

#[test]
fn streamed_gba_repair_rejects_incomplete_boot_signatures() {
    for damaged_offset in [0x08, 0x9F, 0xB2] {
        let mut rom = vec![0x31; 32768];
        rom[4..0xA0].copy_from_slice(&crate::rom_headers::GBA_NINTENDO_LOGO);
        rom[0xB2] = 0x96;
        rom[damaged_offset] ^= 1;
        let mut engine = StreamingVariantChecksums::new(
            &["crc32".to_owned()],
            rom.len() as u64,
            Some("partial.gba"),
            1,
        )
        .expect("stream engine");
        engine.update(&rom).expect("stream update");
        let output = engine.finalize().expect("stream finalize");
        assert!(
            !output.rows.iter().any(|row| row.id == "fix-header"),
            "damaged boot signature at {damaged_offset:#x} must not authorize a GBA write"
        );
    }
}
