use std::env;
use std::path::PathBuf;
use std::process::Command;

const IDENTIFY_PACKS: &[&str] = &[
    "atari-2600.pack",
    "atari-5200.pack",
    "atari-7800.pack",
    "atari-lynx.pack",
    "neo-geo-pocket.pack",
    "neo-geo-pocket-color.pack",
    "nintendo-64.pack",
    "nintendo-entertainment-system.pack",
    "nintendo-game-boy.pack",
    "nintendo-game-boy-advance.pack",
    "nintendo-game-boy-color.pack",
    "nintendo-super-nintendo-entertainment-system.pack",
    "sega-32x.pack",
    "sega-game-gear.pack",
    "sega-master-system.pack",
    "sega-mega-drive-genesis.pack",
    "turbografx-16-pc-engine.pack",
];

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"));
    let data_dir = manifest_dir.join("data/identify/v1");
    let ensure_script = manifest_dir.join("../../scripts/ensure-identify-data.mjs");

    println!("cargo:rerun-if-changed={}", ensure_script.display());
    println!(
        "cargo:rerun-if-changed={}",
        data_dir.join("index.json").display()
    );
    for pack in IDENTIFY_PACKS {
        println!("cargo:rerun-if-changed={}", data_dir.join(pack).display());
    }

    if ensure_script.is_file() {
        let status = Command::new("node")
            .arg(&ensure_script)
            .status()
            .expect("failed to run node to prepare ROM identify data");
        assert!(status.success(), "node failed to prepare ROM identify data");
    }

    let missing = IDENTIFY_PACKS
        .iter()
        .map(|pack| data_dir.join(pack))
        .chain([data_dir.join("index.json")])
        .find(|path| !path.is_file());
    if let Some(path) = missing {
        let relative = path.strip_prefix(&manifest_dir).unwrap_or(&path);
        panic!(
            "missing generated ROM identify data: {}. Run `mise run identify-data` in the repository checkout",
            relative.display()
        );
    }
}
