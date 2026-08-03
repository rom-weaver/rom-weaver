//! Unit coverage for the reusable ROM header repair/validation logic
//! (`CliApp::repair_checksum_file_in_place`). The standalone `batch-header-fixer`
//! CLI command was removed, but the repair code it relied on is still used by the
//! extract/finalize and checksum/patch-apply flows, so its behavior is exercised
//! here directly against fixtures rather than through a command.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::CliApp;

static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Scratch directory that removes itself on drop so fixtures never leak.
struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn new(tag: &str) -> Self {
        let unique = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-header-repair-{}-{tag}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create scratch dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Writes `bytes` to `dir/name`, repairs it in place using the file extension as
/// the profile hint, and returns the repaired and matched profile names.
fn repair_fixture(dir: &Path, name: &str, bytes: &[u8]) -> (PathBuf, Vec<String>, Vec<String>) {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write fixture");
    let outcome =
        CliApp::repair_checksum_file_in_place(&path, Some(&path)).expect("repair header in place");
    let repaired = outcome
        .repaired_profiles
        .iter()
        .map(|profile| (*profile).to_string())
        .collect();
    let matched = outcome
        .matched_without_changes
        .iter()
        .map(|profile| (*profile).to_string())
        .collect();
    (path, repaired, matched)
}

fn gba_header_checksum(bytes: &[u8]) -> u8 {
    let mut checksum = 0_i32;
    for value in &bytes[0xA0..=0xBC] {
        checksum -= i32::from(*value);
    }
    ((checksum - 0x19) & 0xFF) as u8
}

fn build_test_gba_rom(payload_len: usize) -> Vec<u8> {
    let rom_len = payload_len.max(0x200);
    let mut bytes = vec![0u8; rom_len];
    bytes[0x04..0x08].copy_from_slice(&[0x24, 0xFF, 0xAE, 0x51]);
    for (index, value) in bytes[0xA0..=0xBC].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(3).wrapping_add(7);
    }
    bytes[0x1BD] = gba_header_checksum(&bytes);
    for (index, value) in bytes[0x1BE..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(5).wrapping_add(0x31);
    }
    bytes
}

fn build_test_game_boy_rom(payload_len: usize) -> Vec<u8> {
    const GAME_BOY_LOGO: [u8; 48] = [
        0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00,
        0x0D, 0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD,
        0xD9, 0x99, 0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB,
        0xB9, 0x33, 0x3E,
    ];
    let rom_len = payload_len.max(0x200);
    let mut bytes = vec![0u8; rom_len];
    bytes[0x104..0x134].copy_from_slice(&GAME_BOY_LOGO);
    for (index, value) in bytes[0x134..=0x14C].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(7).wrapping_add(0x11);
    }
    for (index, value) in bytes[0x150..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(3).wrapping_add(0x42);
    }
    bytes
}

fn sega_genesis_checksum(bytes: &[u8]) -> u16 {
    let mut sum = 0_u32;
    let mut cursor = 0x200usize;
    while cursor + 1 < bytes.len() {
        let word = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]);
        sum = sum.wrapping_add(u32::from(word));
        cursor += 2;
    }
    if cursor < bytes.len() {
        sum = sum.wrapping_add(u32::from(bytes[cursor]) << 8);
    }
    (sum & 0xFFFF) as u16
}

fn with_a78_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 128];
    headered[1..10].copy_from_slice(b"ATARI7800");
    headered.extend_from_slice(bytes);
    headered
}

fn with_lnx_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 64];
    headered[..4].copy_from_slice(b"LYNX");
    headered.extend_from_slice(bytes);
    headered
}

fn with_nes_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 16];
    headered[..4].copy_from_slice(b"NES\x1A");
    headered.extend_from_slice(bytes);
    headered
}

fn with_fds_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 16];
    headered[..3].copy_from_slice(b"FDS");
    headered.extend_from_slice(bytes);
    headered
}

fn nds_crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0xFFFF_u16;
    for byte in bytes {
        crc ^= u16::from(*byte);
        for _ in 0..8 {
            let carry = (crc & 0x1) != 0;
            crc >>= 1;
            if carry {
                crc ^= 0xA001;
            }
        }
    }
    crc
}

fn build_test_nds_header(unit_code: u8, ntr_rom_size: u32, ntr_twl_rom_size: u32) -> Vec<u8> {
    const HEADER_BYTES: usize = 0x1000;
    const UNIT_CODE_OFFSET: usize = 0x12;
    const NTR_ROM_SIZE_OFFSET: usize = 0x80;
    const HEADER_SIZE_OFFSET: usize = 0x84;
    const LOGO_OFFSET: usize = 0x0C0;
    const LOGO_LENGTH: usize = 156;
    const LOGO_CRC_OFFSET: usize = 0x15C;
    const HEADER_CRC_OFFSET: usize = 0x15E;
    const NTR_TWL_ROM_SIZE_OFFSET: usize = 0x210;

    let mut header = vec![0_u8; HEADER_BYTES];
    header[..12].copy_from_slice(b"RW-TRIM-TEST");
    header[UNIT_CODE_OFFSET] = unit_code;
    header[NTR_ROM_SIZE_OFFSET..NTR_ROM_SIZE_OFFSET + 4]
        .copy_from_slice(&ntr_rom_size.to_le_bytes());
    header[HEADER_SIZE_OFFSET..HEADER_SIZE_OFFSET + 4]
        .copy_from_slice(&(HEADER_BYTES as u32).to_le_bytes());
    header[NTR_TWL_ROM_SIZE_OFFSET..NTR_TWL_ROM_SIZE_OFFSET + 4]
        .copy_from_slice(&ntr_twl_rom_size.to_le_bytes());
    for (index, byte) in header[LOGO_OFFSET..LOGO_OFFSET + LOGO_LENGTH]
        .iter_mut()
        .enumerate()
    {
        *byte = ((index * 37 + 11) % 251) as u8;
    }

    let logo_crc = nds_crc16(&header[LOGO_OFFSET..LOGO_OFFSET + LOGO_LENGTH]);
    header[LOGO_CRC_OFFSET..LOGO_CRC_OFFSET + 2].copy_from_slice(&logo_crc.to_le_bytes());
    let header_crc = nds_crc16(&header[..HEADER_CRC_OFFSET]);
    header[HEADER_CRC_OFFSET..HEADER_CRC_OFFSET + 2].copy_from_slice(&header_crc.to_le_bytes());
    header
}

fn build_test_nds_rom(
    unit_code: u8,
    ntr_rom_size: u32,
    ntr_twl_rom_size: u32,
    file_size: usize,
) -> Vec<u8> {
    const HEADER_BYTES: usize = 0x1000;
    assert!(
        file_size >= HEADER_BYTES,
        "test NDS ROM must fit the full header"
    );
    let mut rom = vec![0_u8; file_size];
    let header = build_test_nds_header(unit_code, ntr_rom_size, ntr_twl_rom_size);
    rom[..HEADER_BYTES].copy_from_slice(&header);
    for (index, byte) in rom.iter_mut().enumerate().skip(HEADER_BYTES) {
        *byte = ((index * 13 + 5) % 251) as u8;
    }
    rom
}

#[test]
fn repair_checksum_file_repairs_gba_and_genesis_headers() {
    let scratch = ScratchDir::new("single");

    let mut gba = build_test_gba_rom(0x5000);
    gba[0x1BD] ^= 0x7F;
    let (gba_path, gba_repaired, gba_matched) = repair_fixture(scratch.path(), "game.gba", &gba);
    assert_eq!(gba_repaired, vec!["gba".to_string()]);
    assert!(gba_matched.is_empty());
    let gba_fixed = fs::read(&gba_path).expect("read gba output");
    assert_eq!(gba_fixed[0x1BD], gba_header_checksum(&gba_fixed));

    let mut genesis = vec![0_u8; 0x300];
    genesis[0x100..0x104].copy_from_slice(b"SEGA");
    genesis[0x200..0x208].copy_from_slice(&[0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
    let (genesis_path, genesis_repaired, _) =
        repair_fixture(scratch.path(), "genesis.md", &genesis);
    assert_eq!(genesis_repaired, vec!["sega-genesis".to_string()]);
    let genesis_fixed = fs::read(&genesis_path).expect("read genesis output");
    let genesis_checksum = u16::from_be_bytes([genesis_fixed[0x18E], genesis_fixed[0x18F]]);
    assert_eq!(genesis_checksum, sega_genesis_checksum(&genesis_fixed));
}

#[test]
fn repair_checksum_file_is_idempotent_for_valid_headers() {
    let scratch = ScratchDir::new("idempotent");

    // A freshly built GBA ROM already carries a correct header checksum, so the
    // repair pass must report it as matched-without-changes and leave the bytes alone.
    let gba = build_test_gba_rom(0x4000);
    let (gba_path, repaired, matched) = repair_fixture(scratch.path(), "valid.gba", &gba);
    assert!(repaired.is_empty(), "valid header must not be repaired");
    assert_eq!(matched, vec!["gba".to_string()]);
    assert_eq!(fs::read(&gba_path).expect("read gba"), gba);
}

#[test]
fn repair_checksum_file_covers_19_profile_matrix() {
    let scratch = ScratchDir::new("matrix");
    let root = scratch.path();

    let mut repaired_profiles: BTreeSet<String> = BTreeSet::new();
    let mut matched_profiles: BTreeSet<String> = BTreeSet::new();
    let mut record = |name: &str, bytes: &[u8]| {
        let (_, repaired, matched) = repair_fixture(root, name, bytes);
        repaired_profiles.extend(repaired);
        matched_profiles.extend(matched);
    };

    let mut snes = vec![0_u8; 0x10000];
    for (index, value) in snes.iter_mut().enumerate().skip(0x200) {
        *value = (index as u8).wrapping_mul(3).wrapping_add(1);
    }
    snes[0x7FC0..0x7FD5].copy_from_slice(b"ROMWEAVER SNES TEST!!");
    record("snes.sfc", &snes);

    let mut nes = with_nes_header(b"nes-payload-1234");
    nes[11] = 0xFF;
    record("nes.nes", &nes);

    record("fds.fds", &with_fds_header(b"fds-payload"));

    let mut game_boy = build_test_game_boy_rom(0x3000);
    game_boy[0x14D] = 0;
    game_boy[0x14E] = 0;
    game_boy[0x14F] = 0;
    record("gameboy.gb", &game_boy);

    let mut gba = build_test_gba_rom(0x5000);
    gba[0x1BD] ^= 0x55;
    record("gba.gba", &gba);

    let mut genesis = vec![0_u8; 0x300];
    genesis[0x100..0x104].copy_from_slice(b"SEGA");
    genesis[0x200..0x210].copy_from_slice(&[
        0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF, 0x10, 0x32, 0x54, 0x76, 0x98, 0xBA, 0xDC,
        0xFE,
    ]);
    record("genesis.md", &genesis);

    let mut sms = vec![0_u8; 0x8000];
    for (index, value) in sms.iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(5).wrapping_add(0x2D);
    }
    sms[0x7FF0..0x7FF8].copy_from_slice(b"TMR SEGA");
    sms[0x7FFF] = 0x0E;
    sms[0x7FFA] = 0;
    sms[0x7FFB] = 0;
    record("sms.gg", &sms);

    let mut n64 = vec![0_u8; 0x101000];
    n64[..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    for (index, value) in n64[0x1000..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(9).wrapping_add(0x11);
    }
    record("n64.z64", &n64);

    let mut a7800 = with_a78_header(&vec![0xAB; 0x800]);
    for value in &mut a7800[0x64..0x80] {
        *value = 0x7E;
    }
    record("a7800.a78", &a7800);

    let mut lynx = with_lnx_header(&vec![0x55; 0x400]);
    lynx[4] = 0;
    lynx[5] = 0;
    for value in &mut lynx[59..64] {
        *value = 0xAA;
    }
    record("lynx.lnx", &lynx);

    let mut pce = vec![0xCC; 512 + 8192];
    pce[512..520].copy_from_slice(b"PCE-DATA");
    record("pcengine.pce", &pce);
    assert_eq!(
        fs::read(root.join("pcengine.pce"))
            .expect("read fixed pce")
            .len(),
        pce.len() - 512,
        "pce copier header (512 bytes) must be stripped"
    );

    let mut virtual_boy = vec![0_u8; 0x600];
    let vb_header_offset = virtual_boy.len() - 0x220;
    for value in &mut virtual_boy[vb_header_offset + 0x14..vb_header_offset + 0x19] {
        *value = 0x5A;
    }
    record("virtualboy.vb", &virtual_boy);

    let mut ngp = vec![0_u8; 0x80];
    ngp[..16].copy_from_slice(b"COPYRIGHT BY SNK");
    for value in &mut ngp[0x24..0x30] {
        *value = 0x21;
    }
    record("ngp.ngp", &ngp);

    let mut msx = vec![0_u8; 0x80];
    msx[..2].copy_from_slice(b"AB");
    for value in &mut msx[0x0A..0x10] {
        *value = 0xF0;
    }
    record("msx.mx1", &msx);

    let mut nds = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000);
    nds[0xC0..0xC4].copy_from_slice(&[0x24, 0xFF, 0xAE, 0x51]);
    nds[0x15E] = 0;
    nds[0x15F] = 0;
    record("nds.nds", &nds);

    record("jaguar.j64", &vec![0_u8; 0x2000]);

    let mut coleco = vec![0_u8; 64];
    coleco[0] = 0xAA;
    coleco[1] = 0x55;
    record("coleco.col", &coleco);

    record("watara.sv", &[0_u8; 64]);
    record("intellivision.int", &[0_u8; 0x50]);

    let expected_repaired: BTreeSet<String> = [
        "snes",
        "nes",
        "game-boy",
        "gba",
        "sega-genesis",
        "sms-gg",
        "n64",
        "atari-7800",
        "atari-lynx",
        "pce-tg16",
        "virtual-boy",
        "neo-geo-pocket",
        "msx",
        "nds",
    ]
    .iter()
    .map(|profile| (*profile).to_string())
    .collect();
    let expected_matched: BTreeSet<String> = [
        "fds",
        "atari-jaguar",
        "colecovision",
        "watara-supervision",
        "intellivision",
    ]
    .iter()
    .map(|profile| (*profile).to_string())
    .collect();

    assert_eq!(
        repaired_profiles, expected_repaired,
        "repaired profile coverage"
    );
    assert_eq!(
        matched_profiles, expected_matched,
        "matched profile coverage"
    );

    // Every supported profile must be accounted for, with no overlap between
    // the repaired and matched sets.
    assert_eq!(repaired_profiles.len() + matched_profiles.len(), 19);
    assert!(repaired_profiles.is_disjoint(&matched_profiles));
}

// --- Per-platform repair coverage below: correct-value assertions, ---
// --- untouched-byte diffing, and already-valid round-trip checks.   ---

/// Builds a fixed-size (0x10000, power-of-two LoROM) SNES ROM with a valid
/// title window at 0x7FC0 and a correct checksum/complement pair already in
/// place, using the same fill pattern as the 19-profile matrix test above
/// (proven not to accidentally match any other profile).
fn build_test_snes_rom() -> Vec<u8> {
    let mut bytes = vec![0_u8; 0x10000];
    for (index, value) in bytes.iter_mut().enumerate().skip(0x200) {
        *value = (index as u8).wrapping_mul(3).wrapping_add(1);
    }
    bytes[0x7FC0..0x7FD5].copy_from_slice(b"ROMWEAVER SNES TEST!!");
    // This fill pattern makes both the lo-ROM (0x7FC0) and hi-ROM (0xFFC0)
    // title windows look printable; `repair_snes_checksum_file` checks
    // hi-ROM first, so it wins and the checksum lives at 0xFFDE/0xFFDC.
    let (checksum, complement) = snes_reference_checksum(&bytes, 0xFFDE, 0xFFDC);
    bytes[0xFFDC..0xFFDE].copy_from_slice(&complement.to_le_bytes());
    bytes[0xFFDE..0xFFE0].copy_from_slice(&checksum.to_le_bytes());
    bytes
}

/// Independent reimplementation of the SNES checksum: sum every byte in the
/// ROM, treating the checksum and complement fields as zero, masked to 16
/// bits. `checksum` is the complement of `sum & 0xFFFF`.
fn snes_reference_checksum(
    bytes: &[u8],
    checksum_offset: usize,
    complement_offset: usize,
) -> (u16, u16) {
    let mut sum = 0_u32;
    for (index, value) in bytes.iter().enumerate() {
        let in_checksum = index >= checksum_offset && index < checksum_offset + 2;
        let in_complement = index >= complement_offset && index < complement_offset + 2;
        if in_checksum || in_complement {
            continue;
        }
        sum = sum.wrapping_add(u32::from(*value));
    }
    let checksum = (sum & 0xFFFF) as u16;
    (checksum, checksum ^ 0xFFFF)
}

#[test]
fn repair_checksum_file_repairs_snes_and_leaves_other_bytes_untouched() {
    let scratch = ScratchDir::new("snes-repair");
    let mut snes = build_test_snes_rom();
    snes[0xFFDE] ^= 0x7F;
    let original = snes.clone();

    let (path, repaired, matched) = repair_fixture(scratch.path(), "corrupt.sfc", &snes);
    assert!(repaired.contains(&"snes".to_string()));
    assert!(!matched.contains(&"snes".to_string()));

    let fixed = fs::read(&path).expect("read snes output");
    let (expected_checksum, expected_complement) = snes_reference_checksum(&fixed, 0xFFDE, 0xFFDC);
    assert_eq!(
        u16::from_le_bytes([fixed[0xFFDE], fixed[0xFFDF]]),
        expected_checksum
    );
    assert_eq!(
        u16::from_le_bytes([fixed[0xFFDC], fixed[0xFFDD]]),
        expected_complement
    );

    let diff: BTreeSet<usize> = (0..original.len())
        .filter(|&index| original[index] != fixed[index])
        .collect();
    let expected_range: BTreeSet<usize> = [0xFFDC, 0xFFDD, 0xFFDE, 0xFFDF].into_iter().collect();
    assert!(
        diff.is_subset(&expected_range),
        "snes repair touched unexpected bytes: {diff:?}"
    );
}

#[test]
fn repair_checksum_file_is_idempotent_for_valid_snes_header() {
    let scratch = ScratchDir::new("snes-idempotent");
    let snes = build_test_snes_rom();
    let (path, repaired, matched) = repair_fixture(scratch.path(), "valid.sfc", &snes);
    assert!(
        repaired.is_empty(),
        "valid snes header must not be repaired"
    );
    assert!(matched.contains(&"snes".to_string()));
    assert_eq!(fs::read(&path).expect("read snes"), snes);
}

#[test]
fn repair_checksum_file_repairs_nes_padding_and_leaves_other_bytes_untouched() {
    let scratch = ScratchDir::new("nes-repair");
    let mut nes = with_nes_header(b"nes-payload-1234");
    nes[11] = 0xFF;
    nes[12] = 0xAB;
    nes[13] = 0xCD;
    nes[14] = 0xEF;
    nes[15] = 0x12;
    let original = nes.clone();

    let (path, repaired, matched) = repair_fixture(scratch.path(), "corrupt.nes", &nes);
    assert!(repaired.contains(&"nes".to_string()));
    assert!(!matched.contains(&"nes".to_string()));

    let fixed = fs::read(&path).expect("read nes output");
    assert_eq!(&fixed[11..16], &[0, 0, 0, 0, 0]);

    let diff: BTreeSet<usize> = (0..original.len())
        .filter(|&index| original[index] != fixed[index])
        .collect();
    let expected_range: BTreeSet<usize> = (11..16).collect();
    assert!(
        diff.is_subset(&expected_range),
        "nes repair touched unexpected bytes: {diff:?}"
    );
}

#[test]
fn repair_checksum_file_is_idempotent_for_valid_nes_header() {
    let scratch = ScratchDir::new("nes-idempotent");
    let nes = with_nes_header(b"nes-payload-1234");
    let (path, repaired, matched) = repair_fixture(scratch.path(), "valid.nes", &nes);
    assert!(repaired.is_empty(), "valid nes header must not be repaired");
    assert!(matched.contains(&"nes".to_string()));
    assert_eq!(fs::read(&path).expect("read nes"), nes);
}

#[test]
fn repair_checksum_file_gba_repair_leaves_other_bytes_untouched() {
    let scratch = ScratchDir::new("gba-repair-bytes");
    let mut gba = build_test_gba_rom(0x4000);
    gba[0x1BD] ^= 0x7F;
    let original = gba.clone();

    let (path, repaired, _) = repair_fixture(scratch.path(), "corrupt.gba", &gba);
    assert!(repaired.contains(&"gba".to_string()));

    let fixed = fs::read(&path).expect("read gba output");
    assert_eq!(fixed[0x1BD], gba_header_checksum(&fixed));

    let diff: BTreeSet<usize> = (0..original.len())
        .filter(|&index| original[index] != fixed[index])
        .collect();
    let expected_range: BTreeSet<usize> = [0x1BD].into_iter().collect();
    assert_eq!(diff, expected_range);
}

/// Builds a Sega Genesis/Mega Drive ROM with the "SEGA" security probe and a
/// correct big-endian checksum at 0x18E already in place.
fn build_test_genesis_rom(payload_len: usize) -> Vec<u8> {
    let rom_len = payload_len.max(0x210);
    let mut bytes = vec![0_u8; rom_len];
    bytes[0x100..0x104].copy_from_slice(b"SEGA");
    for (index, value) in bytes.iter_mut().enumerate().skip(0x200) {
        *value = (index as u8).wrapping_mul(11).wrapping_add(0x13);
    }
    let checksum = sega_genesis_checksum(&bytes);
    bytes[0x18E..0x190].copy_from_slice(&checksum.to_be_bytes());
    bytes
}

#[test]
fn repair_checksum_file_repairs_genesis_and_leaves_other_bytes_untouched() {
    let scratch = ScratchDir::new("genesis-repair");
    let mut genesis = build_test_genesis_rom(0x300);
    genesis[0x18E] ^= 0xFF;
    genesis[0x18F] ^= 0xFF;
    let original = genesis.clone();

    let (path, repaired, matched) = repair_fixture(scratch.path(), "corrupt.md", &genesis);
    assert!(repaired.contains(&"sega-genesis".to_string()));
    assert!(!matched.contains(&"sega-genesis".to_string()));

    let fixed = fs::read(&path).expect("read genesis output");
    let checksum = u16::from_be_bytes([fixed[0x18E], fixed[0x18F]]);
    assert_eq!(checksum, sega_genesis_checksum(&fixed));

    let diff: BTreeSet<usize> = (0..original.len())
        .filter(|&index| original[index] != fixed[index])
        .collect();
    let expected_range: BTreeSet<usize> = [0x18E, 0x18F].into_iter().collect();
    assert!(
        diff.is_subset(&expected_range),
        "genesis repair touched unexpected bytes: {diff:?}"
    );
}

#[test]
fn repair_checksum_file_is_idempotent_for_valid_genesis_header() {
    let scratch = ScratchDir::new("genesis-idempotent");
    let genesis = build_test_genesis_rom(0x300);
    let (path, repaired, matched) = repair_fixture(scratch.path(), "valid.md", &genesis);
    assert!(
        repaired.is_empty(),
        "valid genesis header must not be repaired"
    );
    assert!(matched.contains(&"sega-genesis".to_string()));
    assert_eq!(fs::read(&path).expect("read genesis"), genesis);
}

/// Builds an NDS ROM whose logo window carries the DS/GBA magic bytes at
/// 0xC0..0xC4 (required for the profile to match at all) and a header CRC16
/// that is correct for that content.
fn build_test_valid_nds_rom(file_size: usize) -> Vec<u8> {
    let mut rom = build_test_nds_rom(0x00, 0x3200, 0x3200, file_size);
    rom[0xC0..0xC4].copy_from_slice(&[0x24, 0xFF, 0xAE, 0x51]);
    let header_crc = nds_crc16(&rom[..0x15E]);
    rom[0x15E..0x160].copy_from_slice(&header_crc.to_le_bytes());
    rom
}

#[test]
fn repair_checksum_file_repairs_nds_and_leaves_other_bytes_untouched() {
    let scratch = ScratchDir::new("nds-repair");
    let mut nds = build_test_valid_nds_rom(0x6000);
    nds[0x15E] ^= 0xFF;
    nds[0x15F] ^= 0xFF;
    let original = nds.clone();

    let (path, repaired, matched) = repair_fixture(scratch.path(), "corrupt.nds", &nds);
    assert!(repaired.contains(&"nds".to_string()));
    assert!(!matched.contains(&"nds".to_string()));

    let fixed = fs::read(&path).expect("read nds output");
    let crc = u16::from_le_bytes([fixed[0x15E], fixed[0x15F]]);
    assert_eq!(crc, nds_crc16(&fixed[..0x15E]));

    let diff: BTreeSet<usize> = (0..original.len())
        .filter(|&index| original[index] != fixed[index])
        .collect();
    let expected_range: BTreeSet<usize> = [0x15E, 0x15F].into_iter().collect();
    assert!(
        diff.is_subset(&expected_range),
        "nds repair touched unexpected bytes: {diff:?}"
    );
}

#[test]
fn repair_checksum_file_is_idempotent_for_valid_nds_header() {
    let scratch = ScratchDir::new("nds-idempotent");
    let nds = build_test_valid_nds_rom(0x6000);
    let (path, repaired, matched) = repair_fixture(scratch.path(), "valid.nds", &nds);
    assert!(repaired.is_empty(), "valid nds header must not be repaired");
    assert!(matched.contains(&"nds".to_string()));
    assert_eq!(fs::read(&path).expect("read nds"), nds);
}

/// Builds a minimum-size (0x101000) big-endian `.z64` ROM with a valid byte
/// order magic and a deterministic body fill, matching the fixture shape
/// already proven clean (matches only the `n64` profile) by the 19-profile
/// matrix test above. The checksum words are left at zero so the fixture
/// always starts out wrong.
fn build_test_n64_rom() -> Vec<u8> {
    let mut bytes = vec![0_u8; 0x101000];
    bytes[..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    // The high bit is forced on so every fill byte falls outside the
    // printable ASCII range: the SNES title-window check
    // (`is_valid_snes_title_file`) scans this same body for 21 consecutive
    // printable bytes at 0x7FC0/0xFFC0, and an all-ASCII arithmetic fill
    // (as used elsewhere in this file) happened to satisfy it here, making
    // the SNES repair spuriously fire on this N64 fixture too.
    for (index, value) in bytes[0x1000..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(9).wrapping_add(0x11) | 0x80;
    }
    bytes
}

#[test]
fn repair_checksum_file_repairs_n64_and_leaves_other_bytes_untouched() {
    let scratch = ScratchDir::new("n64-repair");
    let n64 = build_test_n64_rom();
    let original = n64.clone();

    let (path, repaired, matched) = repair_fixture(scratch.path(), "corrupt.z64", &n64);
    assert!(repaired.contains(&"n64".to_string()));
    assert!(!matched.contains(&"n64".to_string()));

    let fixed = fs::read(&path).expect("read n64 output");
    let old_crc = (
        u32::from_be_bytes([
            original[0x10],
            original[0x11],
            original[0x12],
            original[0x13],
        ]),
        u32::from_be_bytes([
            original[0x14],
            original[0x15],
            original[0x16],
            original[0x17],
        ]),
    );
    let new_crc = (
        u32::from_be_bytes([fixed[0x10], fixed[0x11], fixed[0x12], fixed[0x13]]),
        u32::from_be_bytes([fixed[0x14], fixed[0x15], fixed[0x16], fixed[0x17]]),
    );
    // The CIC-style CRC accumulator (seed 0xF8CA4DDC, t1..t6 over every 4-byte
    // word from 0x1000..0x101000) is not reimplemented independently here;
    // the idempotency test below is the primary correctness evidence. This
    // just confirms the all-zero seed values actually got replaced.
    assert_ne!(old_crc, new_crc);

    let diff: BTreeSet<usize> = (0..original.len())
        .filter(|&index| original[index] != fixed[index])
        .collect();
    let expected_range: BTreeSet<usize> = (0x10..0x18).collect();
    assert!(
        diff.is_subset(&expected_range),
        "n64 repair touched unexpected bytes outside the checksum words"
    );
}

#[test]
fn repair_checksum_file_is_idempotent_for_valid_n64_header() {
    let scratch = ScratchDir::new("n64-idempotent");
    let n64 = build_test_n64_rom();

    let (first_path, first_repaired, _) = repair_fixture(scratch.path(), "first.z64", &n64);
    assert!(first_repaired.contains(&"n64".to_string()));
    let repaired_once = fs::read(&first_path).expect("read first n64 repair");

    let (second_path, second_repaired, second_matched) =
        repair_fixture(scratch.path(), "second.z64", &repaired_once);
    assert!(
        second_repaired.is_empty(),
        "already-repaired n64 header must not be repaired again"
    );
    assert!(second_matched.contains(&"n64".to_string()));
    assert_eq!(
        fs::read(&second_path).expect("read second n64 repair"),
        repaired_once
    );
}
