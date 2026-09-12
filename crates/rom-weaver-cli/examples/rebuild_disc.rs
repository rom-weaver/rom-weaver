//! Dev tool: apply a `.dcp` and rebuild the data track, then re-read the
//! rebuilt track to print sample file fingerprints and compare the boot area.
//!
//! Usage: `cargo run --release -p rom-weaver-cli --example rebuild_disc -- <patch.dcp> <track3.bin> [start_lba] [out_track.bin]`

use std::fs::File;
use std::io::{BufReader, Cursor};

use rom_weaver_app::dcp::rebuild_track_to_writer;
use rom_weaver_app::gdrom::{BOOT_AREA_SIZE, GD_HIGH_DENSITY_START_LBA, GdRomFs, IsoTimestamp};

fn md5_hex(bytes: &[u8]) -> String {
    // This display fingerprint uses only length and edge bytes; it is not a checksum.
    format!(
        "{}:{:02x}{:02x}..{:02x}{:02x}",
        bytes.len(),
        bytes.first().copied().unwrap_or(0),
        bytes.get(1).copied().unwrap_or(0),
        bytes.get(bytes.len().wrapping_sub(2)).copied().unwrap_or(0),
        bytes.last().copied().unwrap_or(0),
    )
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dcp_path = args
        .next()
        .expect("usage: rebuild_disc <patch.dcp> <track3.bin> [start_lba] [out]");
    let track_path = args.next().expect("missing track");
    let start_lba = args
        .next()
        .map(|s| s.parse::<u32>().expect("u32"))
        .unwrap_or(GD_HIGH_DENSITY_START_LBA);
    let out_path = args.next();

    let mut dcp = BufReader::new(File::open(&dcp_path).expect("open dcp"));
    let mut source = GdRomFs::open(
        BufReader::new(File::open(&track_path).expect("open track")),
        start_lba,
    )
    .expect("open source");
    let source_count = source.files().len();
    let original_boot = source.read_boot_area().expect("read boot");

    let mut track: Vec<u8> = Vec::new();
    let rebuilt =
        rebuild_track_to_writer(&mut dcp, &mut source, IsoTimestamp::default(), &mut track)
            .expect("rebuild");
    eprintln!(
        "rebuilt track: {} bytes, {} files, boot_replaced={}",
        track.len(),
        rebuilt.file_count,
        rebuilt.boot_sector_replaced
    );

    if let Some(out) = &out_path {
        std::fs::write(out, &track).expect("write track");
        eprintln!("wrote {out}");
    }

    // Re-read the rebuilt track.
    let mut out_fs = GdRomFs::open(Cursor::new(track), start_lba).expect("reopen");
    eprintln!(
        "re-read rebuilt track: {} files (source had {source_count})",
        out_fs.files().len()
    );

    // A patch that replaces IP.BIN can change the boot area.
    let new_boot = out_fs.read_boot_area().expect("read rebuilt boot");
    assert_eq!(new_boot.len(), BOOT_AREA_SIZE);
    println!("boot area preserved: {}", new_boot == original_boot);

    // Print the sample's patched file when present.
    if let Some(makuma) = out_fs.file("MAKUMA.AFS").cloned() {
        let bytes = out_fs.read_file(&makuma).expect("read makuma");
        println!("MAKUMA.AFS fingerprint: {}", md5_hex(&bytes));
    }

    println!(
        "R10CAP.BIN present: {}",
        out_fs.file("R10CAP.BIN").is_some()
    );
}
