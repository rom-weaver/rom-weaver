//! Dev tool: read a `.dcp` and print its classified manifest summary.
//!
//! Usage: `cargo run -p rom-weaver-app --example dump_dcp -- <patch.dcp>`

use std::fs::File;
use std::io::BufReader;

use rom_weaver_app::dcp::{DcpOperation, read_manifest};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: dump_dcp <patch.dcp>");
    let mut reader = BufReader::new(File::open(&path).expect("open dcp"));
    let manifest = read_manifest(&mut reader).expect("read manifest");

    eprintln!(
        "operations: {}  deltas: {}  verbatim: {}  boot_sector: {}",
        manifest.operations.len(),
        manifest.delta_count(),
        manifest.verbatim_count(),
        manifest.has_boot_sector(),
    );
    for op in &manifest.operations {
        match op {
            DcpOperation::Delta { target, entry } => {
                println!("DELTA    {target}\t({} bytes)", entry.uncompressed_size)
            }
            DcpOperation::Verbatim { path, entry } => {
                println!("VERBATIM {path}\t({} bytes)", entry.uncompressed_size)
            }
            DcpOperation::BootSector { entry } => {
                println!("BOOT     IP.BIN\t({} bytes)", entry.uncompressed_size)
            }
        }
    }
}
