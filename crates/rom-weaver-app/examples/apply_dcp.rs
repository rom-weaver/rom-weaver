//! Dev tool: apply a `.dcp` against a GD-ROM data track and report results.
//!
//! Usage: `cargo run -p rom-weaver-app --example apply_dcp -- <patch.dcp> <track3.bin> [start_lba] [out_dir]`
//! With `out_dir`, each patched/verbatim file is written there (flattened);
//! otherwise only a summary + per-file sizes are printed.

use std::fs::{self, File};
use std::io::BufReader;
use std::path::PathBuf;

use rom_weaver_app::dcp::{DcpOutput, apply_dcp};
use rom_weaver_app::gdrom::{GD_HIGH_DENSITY_START_LBA, GdRomFs};

fn main() {
    let mut args = std::env::args().skip(1);
    let dcp_path = args
        .next()
        .expect("usage: apply_dcp <patch.dcp> <track3.bin> [start_lba] [out_dir]");
    let track_path = args.next().expect("missing track path");
    let start_lba = args
        .next()
        .map(|s| s.parse::<u32>().expect("start_lba must be u32"))
        .unwrap_or(GD_HIGH_DENSITY_START_LBA);
    let out_dir = args.next().map(PathBuf::from);
    if let Some(dir) = &out_dir {
        fs::create_dir_all(dir).expect("create out dir");
    }

    let mut dcp = BufReader::new(File::open(&dcp_path).expect("open dcp"));
    let mut fs_reader = GdRomFs::open(
        BufReader::new(File::open(&track_path).expect("open track")),
        start_lba,
    )
    .expect("open GD-ROM filesystem");

    let summary = apply_dcp(&mut dcp, &mut fs_reader, |output| {
        match output {
            DcpOutput::File { path, bytes } => {
                println!("FILE {path}\t{} bytes", bytes.len());
                if let Some(dir) = &out_dir {
                    let flat = path.replace('/', "_");
                    fs::write(dir.join(flat), &bytes)?;
                }
            }
            DcpOutput::BootSector { bytes } => {
                println!("BOOT IP.BIN\t{} bytes", bytes.len());
                if let Some(dir) = &out_dir {
                    fs::write(dir.join("IP.BIN"), &bytes)?;
                }
            }
        }
        Ok(())
    })
    .expect("apply dcp");

    eprintln!(
        "summary: deltas_applied={} verbatim_written={} boot_sector={}",
        summary.deltas_applied, summary.verbatim_written, summary.boot_sector
    );
}
