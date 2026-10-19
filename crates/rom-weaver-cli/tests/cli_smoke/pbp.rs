//! Multi-disc PS1 PBP end to end through the CLI: extract, per-disc checksum/identify, and
//! converting the extracted discs to CHD, ZIP, and 7z.
//!
//! CLI `compress` does not open a PBP, so these tests extract it to `<name>.discNN.cue` +
//! `<name>.discNN.bin` pairs first:
//! - CHD holds exactly one disc, so each run converts one disc's cue.
//! - ZIP and 7z hold every selected cue/bin file in one archive.

use super::shared::*;

const DISC_ONE_SECTORS: u32 = 72;
const DISC_TWO_SECTORS: u32 = 80;

struct MultiDisc {
    temp: TempDir,
    pbp: PathBuf,
    discs: [Vec<u8>; 2],
}

fn multi_disc_pbp() -> MultiDisc {
    let temp = setup_temp_dir();
    let discs = [
        build_test_pbp_iso(DISC_ONE_SECTORS, 7),
        build_test_pbp_iso(DISC_TWO_SECTORS, 23),
    ];
    let pbp = temp.child("multi.pbp").path().to_path_buf();
    fs::write(
        &pbp,
        build_test_pbp_fixture(vec![
            ("SLUS00001", discs[0].clone()),
            ("SLUS00002", discs[1].clone()),
        ]),
    )
    .expect("pbp fixture");
    MultiDisc { temp, pbp, discs }
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf8 path")
}

fn extract_all(input: &Path, out_dir: &Path) {
    command_stdout(
        &[
            "extract",
            "--input",
            path_str(input),
            "--output",
            path_str(out_dir),
            "--jsonl",
        ],
        0,
    );
}

fn extracted_pbp(fixture: &MultiDisc) -> PathBuf {
    let out_dir = fixture.temp.child("pbp-out").path().to_path_buf();
    extract_all(&fixture.pbp, &out_dir);
    out_dir
}

#[test]
fn extract_multi_disc_pbp_lists_every_disc_with_matching_cue_and_exact_bytes() {
    let fixture = multi_disc_pbp();
    let out_dir = extracted_pbp(&fixture);
    for (index, disc) in fixture.discs.iter().enumerate() {
        let stem = format!("multi.disc{:02}", index + 1);
        assert_eq!(
            fs::read(out_dir.join(format!("{stem}.bin"))).expect("disc bin"),
            *disc,
            "{stem}.bin must match the source disc byte for byte"
        );
        let cue = fs::read_to_string(out_dir.join(format!("{stem}.cue"))).expect("disc cue");
        assert!(
            cue.contains(&format!("FILE \"{stem}.bin\" BINARY")),
            "{stem}.cue must reference its own bin: {cue}"
        );
    }
}

#[test]
fn checksum_and_identify_report_per_disc_hashes_for_multi_disc_pbp() {
    let fixture = multi_disc_pbp();
    let database = fixture.temp.child("test.pack");
    fs::write(
        database.path(),
        super::identify::identify_pack_with_crc([0, 0, 0, 0], "unused"),
    )
    .expect("database fixture");
    for (index, disc) in fixture.discs.iter().enumerate() {
        let raw = fixture.temp.child(format!("raw{index}.bin"));
        fs::write(raw.path(), disc).expect("raw disc");
        let expected = checksum_value(raw.path(), "sha1");
        let select = format!("multi.disc{:02}.bin", index + 1);
        for command in ["checksum", "identify"] {
            let mut args = vec![
                command,
                "--input",
                path_str(&fixture.pbp),
                "--select",
                &select,
                "--json",
            ];
            if command == "identify" {
                args.extend(["--database", path_str(database.path())]);
            }
            let terminal = isolated_json_event(&fixture.temp, &args, 0);
            let details = if command == "identify" {
                &terminal["details"]["identify"]
            } else {
                &terminal["details"]
            };
            assert_eq!(
                details["checksums"]["sha1"], expected,
                "{command} sha1 for {select}"
            );
        }
    }
    let first = checksum_value(fixture.temp.child("raw0.bin").path(), "sha1");
    let second = checksum_value(fixture.temp.child("raw1.bin").path(), "sha1");
    assert_ne!(first, second, "the two discs must hash differently");
}

#[test]
fn multi_disc_pbp_converts_to_one_chd_per_disc_that_round_trips() {
    let fixture = multi_disc_pbp();
    let extracted = extracted_pbp(&fixture);
    for (index, disc) in fixture.discs.iter().enumerate() {
        let stem = format!("multi.disc{:02}", index + 1);
        let chd = fixture.temp.child(format!("{stem}.chd"));
        command_stdout(
            &[
                "compress",
                "--input",
                path_str(&extracted.join(format!("{stem}.cue"))),
                "--output",
                path_str(chd.path()),
                "--jsonl",
            ],
            0,
        );
        let round_trip = fixture.temp.child(format!("chd-out-{index}"));
        extract_all(chd.path(), round_trip.path());
        let bins = fs::read_dir(round_trip.path())
            .expect("chd extract dir")
            .map(|entry| entry.expect("entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "bin"))
            .collect::<Vec<_>>();
        assert_eq!(bins.len(), 1, "one disc per CHD");
        assert_eq!(fs::read(&bins[0]).expect("chd bin"), *disc, "{stem}");
    }
}

#[test]
fn multi_disc_pbp_converts_to_zip_and_7z_holding_every_disc() {
    let fixture = multi_disc_pbp();
    let extracted = extracted_pbp(&fixture);
    let inputs = (1..=2)
        .flat_map(|disc| {
            ["cue", "bin"].map(|ext| extracted.join(format!("multi.disc{disc:02}.{ext}")))
        })
        .collect::<Vec<_>>();
    for format in ["zip", "7z"] {
        let archive = fixture.temp.child(format!("multi.{format}"));
        let mut args = vec!["compress"];
        for input in &inputs {
            args.extend(["--input", path_str(input)]);
        }
        args.extend(["--output", path_str(archive.path()), "--jsonl"]);
        command_stdout(&args, 0);
        let out_dir = fixture.temp.child(format!("{format}-out"));
        extract_all(archive.path(), out_dir.path());
        for (index, disc) in fixture.discs.iter().enumerate() {
            let name = format!("multi.disc{:02}.bin", index + 1);
            assert_eq!(
                fs::read(out_dir.path().join(&name)).unwrap_or_else(|_| panic!("{format} {name}")),
                *disc,
                "{format} {name}"
            );
        }
    }
}
