//! Coverage for `src/nod/io/nfs.rs`: header validation, the LBA range to
//! physical sector mapping, the key/file discovery in `load_files`, and the
//! AES-CBC sector decryption performed by `read_block`.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use zerocopy::IntoBytes;

use super::*;
use crate::nod::util::aes::aes_cbc_encrypt;

const NFS_KEY: KeyBytes = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00,
];

/// `Box<BlockReaderNFS>` is not `Debug`, so unwrap error arms by hand rather
/// than using `expect_err`.
fn expect_error<T>(result: Result<T>) -> Error {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(error) => error,
    }
}

fn temp_root(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "rom-weaver-nod-nfs-{label}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp root");
    path
}

/// Two LBA ranges with a gap between them, so `phys_sector` has to walk past
/// the first range and can also miss entirely.
fn test_header() -> NFSHeader {
    let mut header = NFSHeader::new_zeroed();
    header.magic = NFS_MAGIC;
    header.version = 1.into();
    header.num_lba_ranges = 2.into();
    header.lba_ranges[0] = LBARange {
        start_sector: 0.into(),
        num_sectors: 2.into(),
    };
    header.lba_ranges[1] = LBARange {
        start_sector: 4.into(),
        num_sectors: 2.into(),
    };
    header.end_magic = NFS_END_MAGIC;
    header
}

/// Plaintext of the logical sector at `sector`, before AES-CBC encryption.
fn plain_sector(sector: u32) -> Vec<u8> {
    (0..SECTOR_SIZE)
        .map(|index| (index as u32).wrapping_mul(7).wrapping_add(sector) as u8)
        .collect()
}

fn sector_iv(sector: u32) -> KeyBytes {
    let mut iv = [0u8; 16];
    iv[12..].copy_from_slice(&sector.to_be_bytes());
    iv
}

/// Writes `hif_000000.nfs` holding the four physical sectors described by
/// [`test_header`], each encrypted the way a Wii U VC dump stores it.
fn write_nfs_file(dir: &Path, header: &NFSHeader) {
    let mut data = header.as_bytes().to_vec();
    for sector in [0u32, 1, 4, 5] {
        let mut encrypted = plain_sector(sector);
        aes_cbc_encrypt(&NFS_KEY, &sector_iv(sector), &mut encrypted);
        data.extend_from_slice(&encrypted);
    }
    fs::write(dir.join("hif_000000.nfs"), data).expect("write NFS file");
}

// --- NFSHeader ------------------------------------------------------------

#[test]
fn header_validate_rejects_bad_magic_range_count_and_end_magic() {
    test_header()
        .validate()
        .expect("the fixture header is valid");

    let mut header = test_header();
    header.magic = *b"NOPE";
    let error = header.validate().expect_err("bad magic");
    assert!(
        error.to_string().contains("Invalid NFS magic"),
        "unexpected message: {error}"
    );

    let mut header = test_header();
    header.num_lba_ranges = 62.into();
    let error = header.validate().expect_err("too many LBA ranges");
    assert!(
        error.to_string().contains("Invalid NFS LBA range count"),
        "unexpected message: {error}"
    );

    let mut header = test_header();
    header.end_magic = *b"NOPE";
    let error = header.validate().expect_err("bad end magic");
    assert!(
        error.to_string().contains("Invalid NFS end magic"),
        "unexpected message: {error}"
    );
}

#[test]
fn phys_sector_walks_the_lba_ranges_and_reports_gaps() {
    let header = test_header();
    assert_eq!(header.lba_ranges().len(), 2);
    assert_eq!(header.phys_sector(0), 0);
    assert_eq!(header.phys_sector(1), 1);
    assert_eq!(header.phys_sector(4), 2);
    assert_eq!(header.phys_sector(5), 3);
    // Sectors in the gap and past the last range have no physical backing.
    assert_eq!(header.phys_sector(2), u32::MAX);
    assert_eq!(header.phys_sector(3), u32::MAX);
    assert_eq!(header.phys_sector(6), u32::MAX);
}

#[test]
fn calculate_num_files_rounds_up_to_the_250_mib_split_size() {
    let mut header = test_header();
    assert_eq!(header.calculate_num_files(), 1);

    // 250 MiB per file: 8000 sectors plus the header spills into a second.
    header.num_lba_ranges = 1.into();
    header.lba_ranges[0] = LBARange {
        start_sector: 0.into(),
        num_sectors: 8000.into(),
    };
    assert_eq!(header.calculate_num_files(), 2);
}

// --- load_files -----------------------------------------------------------

#[test]
fn load_files_reads_the_key_from_the_sibling_code_directory() {
    let root = temp_root("primary-key");
    let content = root.join("content");
    let code = root.join("code");
    fs::create_dir_all(&content).expect("content dir");
    fs::create_dir_all(&code).expect("code dir");
    fs::write(code.join("htk.bin"), NFS_KEY).expect("write key");
    write_nfs_file(&content, &test_header());

    let reader = BlockReaderNFS::new(&content).expect("NFS opens");
    assert_eq!(reader.key, NFS_KEY);
    assert_eq!(reader.raw_size, 0x200 + 4 * SECTOR_SIZE as u64);
    assert_eq!(reader.disc_size, 6 * SECTOR_SIZE as u64);
    assert_eq!(reader.block_size(), SECTOR_SIZE as u32);

    let meta = reader.meta();
    assert_eq!(meta.format, Format::Nfs);
    assert!(meta.decrypted);

    fs::remove_dir_all(&root).expect("clean up");
}

#[test]
fn load_files_falls_back_to_a_key_beside_the_nfs_files() {
    let root = temp_root("secondary-key");
    let content = root.join("content");
    fs::create_dir_all(&content).expect("content dir");
    fs::write(content.join("htk.bin"), NFS_KEY).expect("write key");
    write_nfs_file(&content, &test_header());

    let reader = BlockReaderNFS::new(&content).expect("NFS opens");
    assert_eq!(reader.key, NFS_KEY);

    fs::remove_dir_all(&root).expect("clean up");
}

#[test]
fn load_files_reports_a_missing_key_file() {
    let root = temp_root("missing-key");
    let content = root.join("content");
    fs::create_dir_all(&content).expect("content dir");
    write_nfs_file(&content, &test_header());

    let error = expect_error(BlockReaderNFS::new(&content));
    assert!(
        error.to_string().contains("Failed to locate"),
        "unexpected message: {error}"
    );

    fs::remove_dir_all(&root).expect("clean up");
}

#[test]
fn load_files_reports_a_missing_nfs_file() {
    let root = temp_root("missing-nfs");
    let content = root.join("content");
    fs::create_dir_all(&content).expect("content dir");
    fs::write(content.join("htk.bin"), NFS_KEY).expect("write key");

    let error = expect_error(BlockReaderNFS::new(&content));
    assert!(
        error.to_string().contains("hif_000000.nfs"),
        "unexpected message: {error}"
    );

    fs::remove_dir_all(&root).expect("clean up");
}

#[test]
fn load_files_reports_a_file_shorter_than_its_lba_ranges_claim() {
    let root = temp_root("short-nfs");
    let content = root.join("content");
    fs::create_dir_all(&content).expect("content dir");
    fs::write(content.join("htk.bin"), NFS_KEY).expect("write key");

    let header = test_header();
    let mut data = header.as_bytes().to_vec();
    data.extend_from_slice(&vec![0u8; SECTOR_SIZE]);
    fs::write(content.join("hif_000000.nfs"), data).expect("write short NFS file");

    let error = expect_error(BlockReaderNFS::new(&content));
    assert!(
        error.to_string().contains("NFS raw size mismatch"),
        "unexpected message: {error}"
    );

    fs::remove_dir_all(&root).expect("clean up");
}

// --- read_block -----------------------------------------------------------

#[test]
fn read_block_decrypts_mapped_sectors_and_skips_unmapped_ones() {
    let root = temp_root("read-block");
    let content = root.join("content");
    fs::create_dir_all(&content).expect("content dir");
    fs::write(content.join("htk.bin"), NFS_KEY).expect("write key");
    write_nfs_file(&content, &test_header());

    let mut reader = BlockReaderNFS::new(&content).expect("NFS opens");
    let mut out = vec![0u8; SECTOR_SIZE];

    for sector in [0u32, 1, 4, 5] {
        let block = reader
            .read_block(&mut out, sector)
            .unwrap_or_else(|e| panic!("sector {sector}: {e}"));
        assert_eq!(block.kind, BlockKind::PartDecrypted { hash_block: true });
        assert_eq!(block.sector, sector);
        assert_eq!(out, plain_sector(sector), "sector {sector} plaintext");
    }

    // A sector with no LBA range is left untouched for the caller to zero.
    out.fill(0xEE);
    let block = reader.read_block(&mut out, 2).expect("gap sector");
    assert_eq!(block.kind, BlockKind::Raw);
    assert!(out.iter().all(|&b| b == 0xEE));

    fs::remove_dir_all(&root).expect("clean up");
}

// --- get_path -------------------------------------------------------------

#[test]
fn get_path_resolves_parent_components_against_the_base_directory() {
    let base = Path::new("/discs/game/content");
    assert_eq!(
        get_path(base, "htk.bin"),
        PathBuf::from("/discs/game/content/htk.bin")
    );
    assert_eq!(
        get_path(base, ["..", "code", "htk.bin"].iter().collect::<PathBuf>()),
        PathBuf::from("/discs/game/code/htk.bin")
    );
}
