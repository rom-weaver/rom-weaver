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
fn extract_multi_disc_pbp_refuses_an_existing_later_disc_before_writing_any() {
    let fixture = multi_disc_pbp();
    let out_dir = fixture.temp.child("pbp-existing").path().to_path_buf();
    fs::create_dir_all(&out_dir).expect("out dir");
    fs::write(out_dir.join("multi.disc02.bin"), b"keep").expect("existing disc");

    command_stdout(
        &[
            "extract",
            "--input",
            path_str(&fixture.pbp),
            "--output",
            path_str(&out_dir),
            "--jsonl",
        ],
        1,
    );
    let mut left = fs::read_dir(&out_dir)
        .expect("read out dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect::<Vec<_>>();
    left.sort();
    assert_eq!(
        left,
        ["multi.disc02.bin"],
        "an existing later output must refuse before any disc is written"
    );
    assert_eq!(
        fs::read(out_dir.join("multi.disc02.bin")).expect("kept"),
        b"keep"
    );
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

fn psp_pbp(executable: &[u8], psar: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 0x28];
    bytes[..4].copy_from_slice(b"\0PBP");
    bytes[4..8].copy_from_slice(&0x10000_u32.to_le_bytes());
    for section in 0..8 {
        let offset = if section == 7 {
            0x28 + executable.len()
        } else {
            0x28
        };
        bytes[8 + section * 4..12 + section * 4]
            .copy_from_slice(&u32::try_from(offset).expect("offset").to_le_bytes());
    }
    bytes.extend_from_slice(executable);
    bytes.extend_from_slice(psar);
    bytes
}

fn psp_nonempty_psar_fixtures() -> Vec<(&'static str, Vec<u8>)> {
    let mut elf = vec![0; 52];
    elf[..7].copy_from_slice(b"\x7fELF\x01\x01\x01");
    elf[18..20].copy_from_slice(&8_u16.to_le_bytes());
    elf[20..24].copy_from_slice(&1_u32.to_le_bytes());
    elf[40..42].copy_from_slice(&52_u16.to_le_bytes());
    let mut prx = vec![0; 0x150];
    prx[..4].copy_from_slice(b"~PSP");
    let mut npumd = vec![0; 256];
    npumd[..8].copy_from_slice(b"NPUMDIMG");
    let mut large = psp_pbp(&elf, b"asset");
    let padding = 2 * 1024 * 1024;
    large.splice(0x28..0x28, std::iter::repeat_n(0, padding));
    for section in 0..8 {
        let offset = if section == 7 {
            0x28 + padding + elf.len()
        } else {
            0x28 + padding
        };
        large[8 + section * 4..12 + section * 4]
            .copy_from_slice(&u32::try_from(offset).expect("offset").to_le_bytes());
    }
    let mut collision = large.clone();
    collision[0x100..0x104].copy_from_slice(b"SEGA");
    vec![
        ("padding-collision", collision),
        ("large-sections", large),
        ("elf-assets", psp_pbp(&elf, b"asset")),
        ("prx-assets", psp_pbp(&prx, b"asset")),
        ("npumd", psp_pbp(&[], &npumd)),
    ]
}

fn assert_psp_nonempty_psar_preserved(name: &str) {
    let (_, bytes) = psp_nonempty_psar_fixtures()
        .into_iter()
        .find(|(fixture, _)| *fixture == name)
        .expect("fixture");
    // Python hashlib.sha1 over each complete synthetic PBP, independent of CLI hashing.
    let expected_sha1 = match name {
        "elf-assets" => "df6424c53e8a2a6c9084faacaf08852045010713",
        "prx-assets" => "6b07ae315c7bbd707d34ddbdaaae0142fb705bc0",
        "npumd" => "abae146504a094569fdcc7340fe53c7c283150e7",
        "large-sections" => "b3e4c071ecbed779d4cf4097329fb107905328cb",
        "padding-collision" => "3ac24b6222f8f7e3d290beb31cbbc868b4059982",
        _ => panic!("unknown fixture"),
    };
    let temp = setup_temp_dir();
    let source = temp.child(format!("{name}.pbp"));
    fs::write(source.path(), &bytes).expect("PSP PBP");
    let database = temp.child("database.pack");
    fs::write(
        database.path(),
        super::identify::identify_pack_with_crc([0; 4], "unused"),
    )
    .expect("database");
    let raw = isolated_json_event(
        &temp,
        &[
            "checksum",
            "--input",
            path_str(source.path()),
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(raw["details"]["checksums"]["sha1"], expected_sha1);
    assert_eq!(
        raw["details"]["checksum_variants"]
            .as_array()
            .expect("variants")
            .len(),
        1,
        "{raw}"
    );
    let inner = temp.child("inner.zip");
    isolated_json_event(
        &temp,
        &[
            "compress",
            "--input",
            path_str(source.path()),
            "--format",
            "zip",
            "--output",
            path_str(inner.path()),
            "--json",
        ],
        0,
    );
    let outer = temp.child("outer.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "inner.zip")], outer.path());
    for (index, input) in [source.path(), inner.path(), outer.path()]
        .into_iter()
        .enumerate()
    {
        for command in ["checksum", "identify"] {
            let mut args = vec![command, "--input", path_str(input), "--json"];
            if command == "identify" {
                args.extend(["--database", path_str(database.path())]);
            }
            let event = isolated_json_event(&temp, &args, 0);
            let details = if command == "identify" {
                &event["details"]["identify"]
            } else {
                &event["details"]
            };
            assert_eq!(
                details["checksums"]["sha1"], expected_sha1,
                "{name} {command} {index}"
            );
            let platform_field = if command == "identify" {
                "detected_platform"
            } else {
                "platform"
            };
            assert_eq!(
                details[platform_field], "Sony Playstation Portable",
                "{name} {command} {index}: {event}"
            );
        }
        let output = temp.child(format!("ingest-{index}"));
        let event = isolated_json_event(
            &temp,
            &[
                "ingest",
                "--input",
                path_str(input),
                "--output",
                path_str(output.path()),
                "--json",
            ],
            0,
        );
        let assets = event["details"]["ingest"]["assets"]
            .as_array()
            .expect("assets");
        assert_eq!(assets.len(), 1);
        assert_eq!(
            assets[0]["platform"], "Sony Playstation Portable",
            "{name} ingest {index}: {event}"
        );
        assert_eq!(assets[0]["checksums"]["sha1"], expected_sha1);
        assert_eq!(
            assets[0]["checksum_variants"]
                .as_array()
                .expect("variants")
                .len(),
            1,
            "{event}"
        );
        assert_eq!(
            fs::read(assets[0]["path"].as_str().expect("path")).expect("ROM bytes"),
            bytes
        );
    }
}

#[test]
fn psp_padding_collision_preserves_checksum_identify_ingest() {
    assert_psp_nonempty_psar_preserved("padding-collision");
}

#[test]
fn psp_nonempty_psar_large_sections_preserve_checksum_identify_ingest() {
    assert_psp_nonempty_psar_preserved("large-sections");
}

#[test]
fn psp_nonempty_psar_elf_preserves_checksum_identify_ingest() {
    assert_psp_nonempty_psar_preserved("elf-assets");
}

#[test]
fn psp_nonempty_psar_prx_preserves_checksum_identify_ingest() {
    assert_psp_nonempty_psar_preserved("prx-assets");
}

#[test]
fn psp_nonempty_psar_npumd_preserves_checksum_identify_ingest() {
    assert_psp_nonempty_psar_preserved("npumd");
}

#[test]
fn psp_nonempty_psar_probe_and_extract_explain_passthrough() {
    for (name, bytes) in psp_nonempty_psar_fixtures() {
        let temp = setup_temp_dir();
        let source = temp.child(format!("{name}.pbp"));
        fs::write(source.path(), &bytes).expect("PSP PBP");
        let probe = isolated_json_event(
            &temp,
            &["probe", "--input", path_str(source.path()), "--json"],
            0,
        );
        assert!(
            probe.to_string().contains(if name == "npumd" {
                "NPUMDIMG"
            } else {
                "asset DATA.PSAR"
            }),
            "{probe}"
        );
        let output = temp.child("extract");
        let error = isolated_json_event(
            &temp,
            &[
                "extract",
                "--input",
                path_str(source.path()),
                "--output",
                path_str(output.path()),
                "--json",
            ],
            1,
        );
        assert!(
            error.to_string().contains("no extractable PS1 disc"),
            "{error}"
        );
        assert!(error.to_string().contains("keep the PBP intact"), "{error}");
        assert_eq!(fs::read(source.path()).expect("source unchanged"), bytes);
    }
}

#[test]
fn ingest_preserves_nested_pbp_only_when_requested() {
    use rom_weaver_app::{AppRunOptions, Commands, RomWeaverApp};
    use rom_weaver_core::{NoninteractivePrompter, ProgressEvent, ProgressSink};
    #[derive(Default)]
    struct Events(Mutex<Vec<ProgressEvent>>);
    impl ProgressSink for Events {
        fn emit(&self, event: ProgressEvent) {
            self.0.lock().unwrap().push(event);
        }
    }
    use std::sync::{Arc, Mutex};

    let fixture = multi_disc_pbp();
    let inner = fixture.temp.child("inner.zip").path().to_path_buf();
    let outer = fixture.temp.child("outer.zip").path().to_path_buf();
    for (source, output) in [(&fixture.pbp, &inner), (&inner, &outer)] {
        command_stdout(
            &[
                "compress",
                "--input",
                path_str(source),
                "--format",
                "zip",
                "--output",
                path_str(output),
                "--json",
            ],
            0,
        );
    }
    fn bins(path: &Path) -> usize {
        fs::read_dir(path)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    bins(&path)
                } else {
                    usize::from(path.extension().is_some_and(|ext| ext == "bin"))
                }
            })
            .sum()
    }
    let invalid_output = fixture.temp.child("invalid-format").path().to_path_buf();
    let invalid: Commands = serde_json::from_value(serde_json::json!({
        "type": "ingest", "args": {"input": inner, "output": invalid_output, "preserve_nested_formats": ["unknown-format"]}
    })).unwrap();
    let events = Arc::new(Events::default());
    let outcome = RomWeaverApp::run(
        invalid,
        AppRunOptions {
            emit_progress_events: false,
            interactive_selection_enabled: false,
            assume_yes: true,
            dry_run: false,
        },
        events.clone(),
        Arc::new(NoninteractivePrompter),
    );
    assert_eq!(outcome.exit_code, 1);
    assert!(!invalid_output.exists());
    assert!(events.0.lock().unwrap().iter().any(|event| {
        event
            .label
            .contains("unknown preserved nested format `unknown-format`")
    }));
    for (depth, input) in [&inner, &outer].iter().enumerate() {
        for (case, formats, expected) in [
            ("default", vec![], 2),
            ("preserved", vec!["PBP"], 0),
            ("alias", vec!["7zip"], 2),
        ] {
            let output = fixture
                .temp
                .child(format!("{depth}-{case}"))
                .path()
                .to_path_buf();
            let mut request = serde_json::json!({
                "type": "ingest", "args": {"input": input, "output": output,
                "preserve_nested_formats": formats, "checksum": ["sha1"], "threads": 1},
            });
            if case == "default" {
                request["args"]
                    .as_object_mut()
                    .unwrap()
                    .remove("preserve_nested_formats");
            }
            let command: Commands = serde_json::from_value(request).expect("typed ingest request");
            let events = Arc::new(Events::default());
            let outcome = RomWeaverApp::run(
                command,
                AppRunOptions {
                    emit_progress_events: false,
                    interactive_selection_enabled: false,
                    assume_yes: true,
                    dry_run: false,
                },
                events.clone(),
                Arc::new(NoninteractivePrompter),
            );
            assert_eq!(outcome.exit_code, 0, "{depth}-{case}");
            assert_eq!(bins(&output), expected, "{depth}-{case}");
            let events = events.0.lock().unwrap();
            let details = events
                .iter()
                .rev()
                .find(|event| event.stage == "ingest" && event.details.is_some())
                .unwrap()
                .details
                .as_ref()
                .unwrap();
            let assets = details["ingest"]["assets"].as_array().expect("ROM assets");
            if case == "preserved" {
                assert_eq!(assets.len(), 1);
                let retained = Path::new(assets[0]["path"].as_str().unwrap());
                assert_eq!(fs::read(retained).unwrap(), fs::read(&fixture.pbp).unwrap());
            } else {
                assert_eq!(
                    assets
                        .iter()
                        .filter(|asset| asset["file_name"]
                            .as_str()
                            .is_some_and(|name| name.ends_with(".bin")))
                        .count(),
                    2
                );
                assert_eq!(
                    assets
                        .iter()
                        .filter(|asset| asset["file_name"]
                            .as_str()
                            .is_some_and(|name| name.ends_with(".cue")))
                        .count(),
                    2
                );
            }
        }
    }
}
