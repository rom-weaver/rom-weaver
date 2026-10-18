use super::shared::*;

fn write_cue_disc(dir: &Path, stem: &str) {
    fs::write(dir.join(format!("{stem}.bin")), stem.as_bytes()).expect("write bin");
    fs::write(
        dir.join(format!("{stem}.cue")),
        format!("FILE \"{stem}.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n"),
    )
    .expect("write cue");
}

fn playlist_args<'a>(inputs: &'a [&'a str], output: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec!["playlist"];
    for input in inputs {
        args.push("--input");
        args.push(input);
    }
    args.extend(["--output", output, "--json"]);
    args.extend(extra);
    args
}

#[test]
fn playlist_orders_discs_given_out_of_order_with_relative_paths() {
    let temp = setup_temp_dir();
    let discs = temp.child("discs");
    fs::create_dir_all(discs.path()).expect("discs dir");
    for stem in ["Game.disc02", "Game.disc10", "Game.disc01"] {
        write_cue_disc(discs.path(), stem);
    }
    let cue = |stem: &str| discs.path().join(format!("{stem}.cue"));
    let (c2, c10, c1) = (cue("Game.disc02"), cue("Game.disc10"), cue("Game.disc01"));
    let out = temp.child("lists/Game.m3u");
    let json = run_single_json_event(
        &playlist_args(
            &[
                c2.to_str().expect("p"),
                c10.to_str().expect("p"),
                // The track file of a given sheet is not a disc of its own.
                discs.path().join("Game.disc01.bin").to_str().expect("p"),
                c1.to_str().expect("p"),
            ],
            out.path().to_str().expect("p"),
            &[],
        ),
        0,
    );
    assert_eq!(json["command"], "playlist");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read_to_string(out.path()).expect("m3u"),
        "../discs/Game.disc01.cue\n../discs/Game.disc02.cue\n../discs/Game.disc10.cue\n"
    );
}

#[test]
fn playlist_no_sort_keeps_the_given_order() {
    let temp = setup_temp_dir();
    for stem in ["Game (Disc 2)", "Game (Disc 1)"] {
        write_cue_disc(temp.path(), stem);
    }
    let two = temp.path().join("Game (Disc 2).cue");
    let one = temp.path().join("Game (Disc 1).cue");
    let out = temp.child("Game.m3u");
    run_single_json_event(
        &playlist_args(
            &[two.to_str().expect("p"), one.to_str().expect("p")],
            out.path().to_str().expect("p"),
            &["--no-sort"],
        ),
        0,
    );
    assert_eq!(
        fs::read_to_string(out.path()).expect("m3u"),
        "Game (Disc 2).cue\nGame (Disc 1).cue\n"
    );
}

#[test]
fn playlist_zip_holds_playlist_discs_and_their_track_files() {
    let temp = setup_temp_dir();
    for stem in ["Game (Disc 2)", "Game (Disc 1)"] {
        write_cue_disc(temp.path(), stem);
    }
    let two = temp.path().join("Game (Disc 2).cue");
    let one = temp.path().join("Game (Disc 1).cue");
    let out = temp.child("Game.zip");
    run_single_json_event(
        &playlist_args(
            &[two.to_str().expect("p"), one.to_str().expect("p")],
            out.path().to_str().expect("p"),
            &[],
        ),
        0,
    );
    let extracted = temp.child("unzipped");
    command_stdout(
        &[
            "extract",
            "--input",
            out.path().to_str().expect("p"),
            "--output",
            extracted.path().to_str().expect("p"),
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read_to_string(extracted.child("Game.m3u").path()).expect("m3u"),
        "Game (Disc 1).cue\nGame (Disc 2).cue\n"
    );
    for name in [
        "Game (Disc 1).cue",
        "Game (Disc 1).bin",
        "Game (Disc 2).cue",
        "Game (Disc 2).bin",
    ] {
        assert!(extracted.child(name).path().is_file(), "{name} in zip");
    }
}

#[test]
fn playlist_refuses_existing_output_and_unknown_extensions() {
    let temp = setup_temp_dir();
    let disc = temp.child("a.chd");
    fs::write(disc.path(), b"chd").expect("disc");
    let existing = temp.child("a.m3u");
    fs::write(existing.path(), b"keep").expect("existing");
    let disc_path = disc.path().to_str().expect("p");
    let json = run_single_json_event(
        &playlist_args(&[disc_path], existing.path().to_str().expect("p"), &[]),
        1,
    );
    assert_eq!(json["status"], "failed");
    assert_eq!(fs::read(existing.path()).expect("kept"), b"keep");
    let bad = temp.child("a.txt");
    let json = run_single_json_event(
        &playlist_args(&[disc_path], bad.path().to_str().expect("p"), &[]),
        1,
    );
    assert_eq!(json["status"], "failed");
    assert!(!bad.path().exists());
}

#[test]
fn playlist_flat_writes_bare_file_names() {
    let temp = setup_temp_dir();
    let discs = temp.child("discs");
    fs::create_dir_all(discs.path()).expect("discs dir");
    for name in ["Game (Disc 2).chd", "Game (Disc 1).chd"] {
        fs::write(discs.path().join(name), b"chd").expect("disc");
    }
    let two = discs.path().join("Game (Disc 2).chd");
    let one = discs.path().join("Game (Disc 1).chd");
    let out = temp.child("elsewhere/Game.m3u");
    run_single_json_event(
        &playlist_args(
            &[two.to_str().expect("p"), one.to_str().expect("p")],
            out.path().to_str().expect("p"),
            &["--flat"],
        ),
        0,
    );
    assert_eq!(
        fs::read_to_string(out.path()).expect("m3u"),
        "Game (Disc 1).chd\nGame (Disc 2).chd\n"
    );
}

#[test]
fn playlist_dry_run_reports_the_playlist_it_would_write() {
    let temp = setup_temp_dir();
    let disc = temp.child("Game (Disc 1).chd");
    fs::write(disc.path(), b"chd").expect("disc");
    let out = temp.child("Game.m3u");
    let json = run_single_json_event(
        &playlist_args(
            &[disc.path().to_str().expect("p")],
            out.path().to_str().expect("p"),
            &["--dry-run"],
        ),
        0,
    );
    assert_eq!(json["details"]["dry_run"], true);
    assert_eq!(json["details"]["read_only"], false);
    assert_eq!(
        json["details"]["writes"],
        serde_json::json!([out.path().to_str().expect("p")])
    );
    assert!(!out.path().exists(), "dry run must not write the playlist");
}

#[test]
fn playlist_m3u_accepts_track_files_outside_the_sheet_folder() {
    let temp = setup_temp_dir();
    let discs = temp.child("discs");
    let bins = temp.child("bins");
    fs::create_dir_all(discs.path()).expect("discs dir");
    fs::create_dir_all(bins.path()).expect("bins dir");
    fs::write(bins.path().join("Game (Disc 1).bin"), b"bin").expect("bin");
    fs::write(
        discs.path().join("Game (Disc 1).cue"),
        "FILE \"../bins/Game (Disc 1).bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n",
    )
    .expect("cue");
    let cue = discs.path().join("Game (Disc 1).cue");
    let out = temp.child("up/Game.m3u");
    run_single_json_event(
        &playlist_args(
            &[cue.to_str().expect("p")],
            out.path().to_str().expect("p"),
            &[],
        ),
        0,
    );
    assert_eq!(
        fs::read_to_string(out.path()).expect("m3u"),
        "../discs/Game (Disc 1).cue\n"
    );
    // A ZIP has to hold the track file, so it still refuses one it cannot store.
    let zip = temp.child("up/Game.zip");
    let json = run_single_json_event(
        &playlist_args(
            &[cue.to_str().expect("p")],
            zip.path().to_str().expect("p"),
            &[],
        ),
        1,
    );
    assert_eq!(json["status"], "failed");
}

#[test]
fn playlist_lists_a_ccd_image_once_without_its_data_files() {
    let temp = setup_temp_dir();
    for disc in [1, 2] {
        for extension in ["ccd", "img", "sub"] {
            fs::write(
                temp.path().join(format!("Game (Disc {disc}).{extension}")),
                b"x",
            )
            .expect("image file");
        }
    }
    let inputs: Vec<_> = ["ccd", "img", "sub"]
        .iter()
        .flat_map(|extension| (1..=2).map(move |disc| format!("Game (Disc {disc}).{extension}")))
        .map(|name| temp.path().join(name).to_str().expect("p").to_string())
        .collect();
    let input_refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
    let out = temp.child("Game.m3u");
    run_single_json_event(
        &playlist_args(&input_refs, out.path().to_str().expect("p"), &["--flat"]),
        0,
    );
    assert_eq!(
        fs::read_to_string(out.path()).expect("m3u"),
        "Game (Disc 1).ccd\nGame (Disc 2).ccd\n"
    );
}

#[test]
fn playlist_zip_finds_track_files_staged_under_ascii_names() {
    // The browser stages `Pokémon (Disc N).bin` as `Pok_mon (Disc N).bin` but the cue text keeps the
    // real name; the tracks must still be taken as the cue's, not listed as discs.
    let temp = setup_temp_dir();
    for number in [1, 2] {
        let staged = format!("Pok_mon (Disc {number})");
        fs::write(temp.path().join(format!("{staged}.bin")), staged.as_bytes()).expect("write bin");
        fs::write(
            temp.path().join(format!("{staged}.cue")),
            format!(
                "FILE \"Pok\u{e9}mon (Disc {number}).bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n"
            ),
        )
        .expect("write cue");
    }
    let mut inputs = Vec::new();
    for name in [
        "Pok_mon (Disc 1).cue",
        "Pok_mon (Disc 1).bin",
        "Pok_mon (Disc 2).cue",
        "Pok_mon (Disc 2).bin",
    ] {
        inputs.push(temp.path().join(name).to_str().expect("p").to_string());
    }
    let input_refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
    let out = temp.child("Game.zip");
    run_single_json_event(
        &playlist_args(&input_refs, out.path().to_str().expect("p"), &[]),
        0,
    );
    let extracted = temp.child("unzipped");
    command_stdout(
        &[
            "extract",
            "--input",
            out.path().to_str().expect("p"),
            "--output",
            extracted.path().to_str().expect("p"),
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read_to_string(extracted.child("Game.m3u").path()).expect("m3u"),
        "Pok_mon (Disc 1).cue\nPok_mon (Disc 2).cue\n"
    );
    assert!(
        extracted
            .child("Pok\u{e9}mon (Disc 1).bin")
            .path()
            .is_file()
    );
}
