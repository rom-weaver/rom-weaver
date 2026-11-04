//! Dev tool: write `gcjunk-nkit.rvz` and `gcjunk-nkit.wia`, GameCube images whose NKit header
//! stores the CRC32, MD5, SHA-1, and XXH64 of the ISO, as nodtool and NKit images do.
//! `rom-weaver compress` stores none of them, so only images like these reach the extract-side
//! NKit digest check. The 512 MiB ISO is a disc header, 1 MiB of seeded data, and disc junk, the
//! shape of a retail disc; RVZ stores the junk as seeds, so the RVZ is about 2 MB.
//!
//! Usage: `cargo run --release -p rom-weaver-containers --example nkit_fixture -- <out_dir>`

use std::fs::{self, File};
use std::io::{BufWriter, Seek, Write};
use std::path::{Path, PathBuf};

use rom_weaver_containers::nod::{
    common::{Compression, Format},
    read::{DiscOptions, DiscReader},
    util::lfg::LaggedFibonacci,
    write::{DiscWriter, FormatOptions, ProcessOptions},
};

const SECTOR_SIZE: u64 = 0x8000;
const DISC_SIZE: u64 = 512 * 1024 * 1024;
const DATA_SIZE: u64 = 1024 * 1024;
const DISC_ID: [u8; 4] = *b"RWTE";

fn main() {
    let out_dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: nkit_fixture <out_dir>"),
    );
    fs::create_dir_all(&out_dir).expect("create output directory");
    let iso = out_dir.join("gcjunk-nkit.iso");
    write_iso(&iso);
    // WIA stays uncompressed: it has no junk seeds, and LZMA over 511 MiB of junk takes over a
    // minute without making the extract any more representative.
    write_image(
        &iso,
        &out_dir.join("gcjunk-nkit.rvz"),
        Format::Rvz,
        Format::Rvz.default_compression(),
    );
    write_image(
        &iso,
        &out_dir.join("gcjunk-nkit.wia"),
        Format::Wia,
        Compression::None,
    );
    fs::remove_file(&iso).expect("remove intermediate ISO");
}

fn write_iso(path: &Path) {
    let mut header = vec![0_u8; SECTOR_SIZE as usize];
    header[..6].copy_from_slice(b"RWTEST");
    header[0x1C..0x20].copy_from_slice(&[0xC2, 0x33, 0x9F, 0x3D]);
    let title = b"rom-weaver-bench\0";
    header[0x20..0x20 + title.len()].copy_from_slice(title);
    // A fixed xorshift stream stands in for file data, so every run writes the same image.
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let data = (0..DATA_SIZE / 8)
        .flat_map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state.to_le_bytes()
        })
        .collect::<Vec<_>>();
    let mut out = BufWriter::new(File::create(path).expect("create ISO"));
    out.write_all(&header).expect("write disc header");
    out.write_all(&data).expect("write disc data");
    let junk_start = SECTOR_SIZE + DATA_SIZE;
    LaggedFibonacci::default()
        .write_sector_chunked(&mut out, DISC_SIZE - junk_start, DISC_ID, 0, junk_start)
        .expect("write disc junk");
    out.flush().expect("flush ISO");
}

fn write_image(iso: &Path, path: &Path, format: Format, compression: Compression) {
    let disc = DiscReader::new(iso, &DiscOptions::default()).expect("open ISO");
    let options = FormatOptions {
        format,
        compression,
        block_size: format.default_block_size(),
    };
    let writer = DiscWriter::new(disc, &options).expect("create disc writer");
    let mut out = File::create(path).expect("create image");
    let finalization = writer
        .process(
            |data, _, _| out.write_all(data.as_ref()),
            &ProcessOptions {
                digest_crc32: true,
                digest_md5: true,
                digest_sha1: true,
                digest_xxh64: true,
                ..Default::default()
            },
        )
        .expect("write image");
    if !finalization.header.is_empty() {
        out.rewind().expect("rewind image");
        out.write_all(finalization.header.as_ref())
            .expect("write image header");
    }
}
