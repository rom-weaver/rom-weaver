//! Coverage for `src/nod/io/wbfs.rs` reading: a sparse, virtual WBFS stream
//! larger than 4 GiB (dual-layer sized) and the single-disc restriction.

use std::io;

use super::*;
use crate::nod::read::DiscStream;

const SECTOR_SHIFT: u8 = 9;
const BLOCK_SHIFT: u8 = 21;
const BLOCK_SIZE: u64 = 1 << BLOCK_SHIFT;
/// Physical size of the virtual WBFS file: just over 8 GiB.
const PHYSICAL_BLOCKS: u64 = 4100;

/// A WBFS file whose payload blocks are generated on demand, so a >4 GiB
/// image costs no memory or disk.
#[derive(Clone)]
struct VirtualWbfs {
    head: Vec<u8>,
}

fn pattern(offset: u64) -> u8 {
    (offset % 251) as u8
}

impl VirtualWbfs {
    fn new(extra_discs: bool, mapped: &[(u32, u16)]) -> Self {
        let sector_size = 1u64 << SECTOR_SHIFT;
        let num_sectors = (PHYSICAL_BLOCKS * BLOCK_SIZE / sector_size) as u32;
        let mut head = vec![0u8; BLOCK_SIZE as usize];
        head[..4].copy_from_slice(b"WBFS");
        head[4..8].copy_from_slice(&num_sectors.to_be_bytes());
        head[8] = SECTOR_SHIFT;
        head[9] = BLOCK_SHIFT;
        head[10] = 1;
        head[12] = 1; // disc 0 present
        if extra_discs {
            head[13] = 1; // disc 1 present: a multi-game drive image
        }
        let map_start = sector_size as usize + 0x100;
        for &(logical, physical) in mapped {
            let at = map_start + logical as usize * 2;
            head[at..at + 2].copy_from_slice(&physical.to_be_bytes());
        }
        Self { head }
    }
}

impl DiscStream for VirtualWbfs {
    fn read_exact_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        for (index, byte) in buf.iter_mut().enumerate() {
            let position = offset + index as u64;
            *byte = if position < BLOCK_SIZE {
                self.head[position as usize]
            } else {
                pattern(position)
            };
        }
        Ok(())
    }

    fn stream_len(&mut self) -> io::Result<u64> {
        Ok(PHYSICAL_BLOCKS * BLOCK_SIZE)
    }
}

#[test]
fn reads_blocks_stored_beyond_4_gib_and_virtual_discs_beyond_4_gib() {
    // Logical block 3000 (offset ~6.3 GiB) lives in physical block 4000
    // (offset ~7.8 GiB); both are past the 32-bit boundary.
    let mut reader = BlockReaderWBFS::new(Box::new(VirtualWbfs::new(false, &[(3000, 4000)])))
        .expect("open virtual wbfs");
    let mut out = vec![0u8; BLOCK_SIZE as usize];
    let sector = (3000 * BLOCK_SIZE / 0x8000) as u32;
    let block = reader.read_block(&mut out, sector).expect("read block");
    assert!(matches!(block.kind, BlockKind::Raw));
    let physical_start = 4000 * BLOCK_SIZE;
    assert!(physical_start > u64::from(u32::MAX));
    assert!(
        out.iter()
            .enumerate()
            .all(|(index, byte)| *byte == pattern(physical_start + index as u64))
    );

    let unmapped = reader
        .read_block(&mut out, (10 * BLOCK_SIZE / 0x8000) as u32)
        .expect("read unmapped block");
    assert!(matches!(unmapped.kind, BlockKind::Zero));
}

#[test]
fn rejects_multi_disc_wbfs_images() {
    let error = BlockReaderWBFS::new(Box::new(VirtualWbfs::new(true, &[])))
        .err()
        .expect("multi-disc image must be rejected");
    assert!(
        error.to_string().contains("Only single WBFS discs"),
        "{error}"
    );
}

#[test]
fn rejects_truncated_split_sets() {
    // A missing `.wbf1` part leaves the stream shorter than the header claims.
    #[derive(Clone)]
    struct Truncated(VirtualWbfs);
    impl DiscStream for Truncated {
        fn read_exact_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<()> {
            self.0.read_exact_at(buf, offset)
        }
        fn stream_len(&mut self) -> io::Result<u64> {
            Ok(BLOCK_SIZE * 2)
        }
    }
    let error = BlockReaderWBFS::new(Box::new(Truncated(VirtualWbfs::new(false, &[]))))
        .err()
        .expect("truncated set must be rejected");
    assert!(
        error.to_string().contains("Invalid WBFS file size"),
        "{error}"
    );
}
