//! Dev tool: read a GD-ROM data track's whole filesystem, re-author it with the
//! ISO writer, and verify every file reads back byte-identical.
//!
//! Usage: `cargo run --release -p rom-weaver-app --example roundtrip -- <track.bin> [start_lba]`

use std::fs::File;
use std::io::{BufReader, Cursor};

use rom_weaver_app::gdrom::{GD_HIGH_DENSITY_START_LBA, GdRomFs, IsoFile, IsoTimestamp, build_iso};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .expect("usage: roundtrip <track.bin> [start_lba]");
    let start_lba = args
        .next()
        .map(|s| s.parse::<u32>().expect("u32"))
        .unwrap_or(GD_HIGH_DENSITY_START_LBA);

    // Read the original filesystem.
    let mut src = GdRomFs::open(BufReader::new(File::open(&path).expect("open")), start_lba)
        .expect("open source fs");
    let entries: Vec<_> = src.files().values().cloned().collect();
    let mut files = Vec::with_capacity(entries.len());
    for entry in &entries {
        files.push(IsoFile {
            path: entry.path.clone(),
            data: src.read_file(entry).expect("read source file"),
        });
    }
    eprintln!("read {} files from source", files.len());

    // Re-author and read back.
    let cooked = build_iso(&files, start_lba, IsoTimestamp::default()).expect("build iso");
    eprintln!(
        "authored cooked image: {} bytes ({} sectors)",
        cooked.len(),
        cooked.len() / 2048
    );
    let mut rebuilt = GdRomFs::open(Cursor::new(cooked), start_lba).expect("open rebuilt");

    let mut ok = 0usize;
    let mut bad = 0usize;
    for f in &files {
        match rebuilt.file(&f.path).cloned() {
            Some(entry) => {
                let got = rebuilt.read_file(&entry).expect("read rebuilt file");
                if got == f.data {
                    ok += 1;
                } else {
                    bad += 1;
                    eprintln!(
                        "MISMATCH {}: {} vs {} bytes",
                        f.path,
                        got.len(),
                        f.data.len()
                    );
                }
            }
            None => {
                bad += 1;
                eprintln!("MISSING {}", f.path);
            }
        }
    }
    eprintln!(
        "round-trip: {ok} ok, {bad} mismatched, total {}",
        files.len()
    );
    if bad != 0 {
        std::process::exit(1);
    }
}
