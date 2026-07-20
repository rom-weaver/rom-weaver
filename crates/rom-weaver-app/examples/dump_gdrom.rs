//! Dev tool: open a GD-ROM/CD data track and list (or extract) its ISO9660
//! files.
//!
//! List:    `cargo run -p rom-weaver-app --example dump_gdrom -- <track.bin> [start_lba]`
//! Extract: `cargo run -p rom-weaver-app --example dump_gdrom -- <track.bin> <start_lba> <NAME> <out>`
//! `start_lba` defaults to the GD high-density start (45000).

use std::env;
use std::fs::File;
use std::io::BufReader;

use rom_weaver_app::gdrom::{GD_HIGH_DENSITY_START_LBA, GdRomFs};

fn main() {
    let mut args = env::args().skip(1);
    let path = args
        .next()
        .expect("usage: dump_gdrom <track.bin> [start_lba] [NAME out]");
    let start_lba = args
        .next()
        .map(|s| s.parse::<u32>().expect("start_lba must be a u32"))
        .unwrap_or(GD_HIGH_DENSITY_START_LBA);
    let extract = args.next();
    let out = args.next();

    let reader = BufReader::new(File::open(&path).expect("open track"));
    let mut fs = GdRomFs::open(reader, start_lba).expect("parse GD-ROM filesystem");

    eprintln!(
        "sector format: {:?}  start_lba={}  files={}",
        fs.sector_format(),
        fs.start_lba(),
        fs.files().len()
    );

    if let (Some(name), Some(out)) = (extract, out) {
        let entry = fs.file(&name).expect("file not found").clone();
        let bytes = fs.read_file(&entry).expect("read file");
        std::fs::write(&out, &bytes).expect("write out");
        eprintln!("extracted {name} -> {out} ({} bytes)", bytes.len());
        return;
    }

    for (name, entry) in fs.files() {
        println!("{}\t{} bytes\tlba {}", name, entry.size, entry.extent_lba);
    }
}
