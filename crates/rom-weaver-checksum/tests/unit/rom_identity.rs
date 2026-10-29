use super::*;

const PBP_MAGIC: [u8; 4] = [0x00, b'P', b'B', b'P'];
const PBP_HEADER_LEN: usize = 0x28;

fn pbp_header(len: usize, psar_offset: u32) -> Vec<u8> {
    let mut header = vec![0u8; len];
    header[..4].copy_from_slice(&PBP_MAGIC);
    if len >= PBP_HEADER_LEN {
        for section in 0..7 {
            header[8 + section * 4..12 + section * 4].copy_from_slice(&0x28_u32.to_le_bytes());
        }
        header[0x24..0x28].copy_from_slice(&psar_offset.to_le_bytes());
    }
    header
}

#[test]
fn pbp_header_of_exact_minimum_length_is_read() {
    let header = pbp_header(PBP_HEADER_LEN, 0x28);
    assert_eq!(
        detect_rom_identity(&header, 0x28, Some(".pbp")).platform,
        Some(platform::PSP)
    );
    assert_eq!(
        detect_rom_identity(&header, 0x29, Some(".pbp")).platform,
        None
    );
}

#[test]
fn truncated_pbp_header_is_rejected_without_panicking() {
    for len in PBP_MAGIC.len()..PBP_HEADER_LEN {
        let header = pbp_header(len, 0);
        assert_eq!(
            detect_rom_identity(&header, 0, Some(".pbp")).platform,
            None,
            "prefix length {len}"
        );
    }
}

#[test]
fn non_pbp_header_of_full_length_is_rejected() {
    let mut header = pbp_header(PBP_HEADER_LEN, 0x28);
    header[1] = b'X';
    assert_eq!(
        detect_rom_identity(&header, 0x28, Some(".pbp")).platform,
        None
    );
}

#[test]
fn pbp_signature_selects_bounded_seek_fallback_only_for_a_leading_complete_magic() {
    for bytes in [
        b"".as_slice(),
        b"\0",
        b"\0P",
        b"\0PB",
        b"\0pbp",
        b"XPBP",
        b"\0PBO",
        b"x\0PBP",
        b"NES\x1a",
    ] {
        let mut prefix = IdentityPrefix::new();
        prefix.push(bytes);
        assert!(!prefix.has_pbp_signature(), "non-PBP prefix {bytes:?}");
    }
    let mut prefix = IdentityPrefix::new();
    for (index, byte) in PBP_MAGIC.into_iter().enumerate() {
        prefix.push(&[byte]);
        assert_eq!(prefix.has_pbp_signature(), index == 3, "byte {index}");
    }
    prefix.push(&vec![0x5a; DETECT_PREFIX_BYTES]);
    assert!(prefix.is_full());
    assert!(prefix.has_pbp_signature());
    let mut non_pbp = IdentityPrefix::new();
    non_pbp.push(b"NES\x1a");
    non_pbp.push(&vec![0x5a; DETECT_PREFIX_BYTES]);
    assert!(non_pbp.is_full());
    assert!(!non_pbp.has_pbp_signature());
}

struct PbpIdentityFiles(std::path::PathBuf);

impl PbpIdentityFiles {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..100 {
            let path = std::env::temp_dir().join(format!(
                "rom-weaver-pbp-identity-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create identity fixture directory: {error}"),
            }
        }
        panic!("find an unused identity fixture directory");
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}

impl Drop for PbpIdentityFiles {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("remove identity fixtures");
    }
}

fn psp_elf_header() -> [u8; 52] {
    let mut elf = [0; 52];
    elf[..7].copy_from_slice(b"\x7fELF\x01\x01\x01");
    elf[18..20].copy_from_slice(&8_u16.to_le_bytes());
    elf[20..24].copy_from_slice(&1_u32.to_le_bytes());
    elf[40..42].copy_from_slice(&52_u16.to_le_bytes());
    elf
}

fn write_psp_pbp(path: &Path, start: u32, executable: &[u8], psar: &[u8]) {
    use std::io::{SeekFrom, Write};
    let mut header = pbp_header(
        40,
        start + u32::try_from(executable.len()).expect("executable size"),
    );
    for section in 0..7 {
        header[8 + section * 4..12 + section * 4].copy_from_slice(&start.to_le_bytes());
    }
    let mut file = File::create(path).expect("create PBP fixture");
    file.write_all(&header).expect("write PBP table");
    file.seek(SeekFrom::Start(u64::from(start)))
        .expect("seek past media sections");
    file.write_all(executable).expect("write DATA.PSP");
    file.write_all(psar).expect("write DATA.PSAR");
}

fn file_sha1(path: &Path) -> Vec<u8> {
    use sha1::{Digest, Sha1};
    let mut digest = Sha1::new();
    let mut file = File::open(path).expect("open fixture for SHA1");
    let mut buffer = [0; 8192];
    loop {
        let count = file.read(&mut buffer).expect("read fixture for SHA1");
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    digest.finalize().to_vec()
}

#[test]
fn pbp_identity_for_path_recovers_each_psp_layout_beyond_the_stream_prefix() {
    let files = PbpIdentityFiles::new();
    let elf = psp_elf_header();
    let mut prx = [0; 336];
    prx[..4].copy_from_slice(b"~PSP");
    let mut npumd = [0; 256];
    npumd[..8].copy_from_slice(b"NPUMDIMG");
    for (name, executable, psar) in [
        ("ELF assets 雪.pbp", elf.as_slice(), b"assets".as_slice()),
        ("PRX assets.PBP", prx.as_slice(), b"assets".as_slice()),
        ("NPUMDIMG.bin", b"".as_slice(), npumd.as_slice()),
    ] {
        for start in [
            40,
            u32::try_from(DETECT_PREFIX_BYTES).expect("prefix size") + 17,
        ] {
            let path = files.path(name);
            write_psp_pbp(&path, start, executable, psar);
            let original_sha1 = file_sha1(&path);
            let original_size = path.metadata().expect("fixture metadata").len();
            let mut prefix = IdentityPrefix::new();
            let mut file = File::open(&path).expect("open streaming fixture");
            let mut buffer = [0; 8192];
            loop {
                let count = file.read(&mut buffer).expect("stream fixture");
                if count == 0 {
                    break;
                }
                prefix.push(&buffer[..count]);
            }
            assert!(prefix.has_pbp_signature());
            if start > DETECT_PREFIX_BYTES as u32 {
                assert!(prefix.is_full());
                assert!(
                    prefix.detect(Some(".pbp")).is_empty(),
                    "headers must be beyond the captured prefix"
                );
            } else {
                assert_eq!(prefix.detect(Some(".pbp")).platform, Some(platform::PSP));
            }
            let identity = detect_rom_identity_for_path(&path);
            assert_eq!(
                identity.platform,
                Some(platform::PSP),
                "{name} offset {start}"
            );
            assert_eq!(identity.disc_format, None);
            assert_eq!(
                path.metadata().expect("fixture metadata").len(),
                original_size
            );
            assert_eq!(
                file_sha1(&path),
                original_sha1,
                "file reads preserve every byte"
            );
        }
    }
}

#[test]
fn pbp_identity_for_path_rejects_unknown_and_malformed_payloads() {
    use std::io::{SeekFrom, Write};
    let files = PbpIdentityFiles::new();
    let path = files.path("invalid.pbp");
    let mut prx = [0; 336];
    prx[..4].copy_from_slice(b"~PSP");
    let mut npumd = [0; 255];
    npumd[..8].copy_from_slice(b"NPUMDIMG");
    let mut wrong_machine = psp_elf_header();
    wrong_machine[18] = 62;
    for (executable, psar) in [
        (
            b"unknown executable".as_slice(),
            b"unknown PSAR data".as_slice(),
        ),
        (wrong_machine.as_slice(), b"assets".as_slice()),
        (&psp_elf_header()[..51], b"assets".as_slice()),
        (&prx[..335], b"assets".as_slice()),
        (prx.as_slice(), npumd.as_slice()),
        (prx.as_slice(), b"PSISOIMG0000xxxx".as_slice()),
        (prx.as_slice(), b"PSTITLEIMG000000".as_slice()),
        (prx.as_slice(), b"PSISOIMG9999xxxx".as_slice()),
    ] {
        write_psp_pbp(&path, 40, executable, psar);
        assert!(
            detect_rom_identity_for_path(&path).is_empty(),
            "{executable:?} {psar:?}"
        );
    }
    for (field, offset) in [(8, 0_u32), (12, 39), (32, 377), (36, u32::MAX)] {
        write_psp_pbp(&path, 40, &prx, b"assets");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open section table");
        file.seek(SeekFrom::Start(field))
            .expect("seek to section field");
        file.write_all(&offset.to_le_bytes())
            .expect("invalidate section table");
        drop(file);
        assert!(
            detect_rom_identity_for_path(&path).is_empty(),
            "invalid section {field}"
        );
    }
}

#[test]
fn pbp_path_probing_preserves_empty_psar_and_non_pbp_cartridge_fallback() {
    let files = PbpIdentityFiles::new();
    let path = files.path("EBOOT.PBP");
    write_psp_pbp(&path, 40, &[], &[]);
    assert_eq!(
        detect_rom_identity_for_path(&path).platform,
        Some(platform::PSP)
    );
    let cartridge = files.path("game.nes");
    let mut nes = vec![0; 16 + 32768];
    nes[..4].copy_from_slice(b"NES\x1a");
    std::fs::write(&cartridge, &nes).expect("write non-PBP ROM");
    let identity = detect_rom_identity_for_path(&cartridge);
    assert_eq!(identity.platform, Some(platform::NES));
    assert_eq!(identity.disc_format, None);
    assert_eq!(std::fs::read(&cartridge).expect("read cartridge"), nes);
    assert!(detect_rom_identity_for_path(&files.path("missing.pbp")).is_empty());
}
