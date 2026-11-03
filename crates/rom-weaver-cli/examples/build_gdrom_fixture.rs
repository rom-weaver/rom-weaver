//! Dev tool: write a small three-track GD-ROM disc for `.dcp` tests: a low-density data track, an
//! audio track, and a high-density data track whose ISO9660 filesystem holds the given files.
//!
//! Usage: `cargo run -p rom-weaver-cli --example build_gdrom_fixture -- <out_dir> <NAME=path>...`

use std::fs;
use std::path::PathBuf;

use rom_weaver_app::gdrom::{
    GD_HIGH_DENSITY_START_LBA, IsoFile, IsoTimestamp, USER_DATA_SIZE, build_iso,
    encode_mode1_sector,
};

fn main() {
    let mut args = std::env::args().skip(1);
    let out_dir = PathBuf::from(
        args.next()
            .expect("usage: build_gdrom_fixture <out_dir> <NAME=path>..."),
    );
    let files = args
        .map(|arg| {
            let (name, path) = arg.split_once('=').expect("file argument is NAME=path");
            IsoFile {
                path: name.to_string(),
                data: fs::read(path).expect("read file"),
            }
        })
        .collect::<Vec<_>>();
    let cooked =
        build_iso(&files, GD_HIGH_DENSITY_START_LBA, IsoTimestamp::default()).expect("build ISO");
    let high_density = cooked
        .chunks_exact(USER_DATA_SIZE)
        .enumerate()
        .flat_map(|(index, sector)| {
            encode_mode1_sector(
                GD_HIGH_DENSITY_START_LBA + index as u32,
                sector.try_into().expect("cooked sector"),
            )
        })
        .collect::<Vec<_>>();
    let low_density = (0..8)
        .flat_map(|index| encode_mode1_sector(index, &[0; USER_DATA_SIZE]))
        .collect::<Vec<_>>();
    fs::create_dir_all(&out_dir).expect("output directory");
    fs::write(out_dir.join("track01.bin"), low_density).expect("track01");
    fs::write(out_dir.join("track02.bin"), vec![0; 8 * 2352]).expect("track02");
    fs::write(out_dir.join("track03.bin"), high_density).expect("track03");
}
