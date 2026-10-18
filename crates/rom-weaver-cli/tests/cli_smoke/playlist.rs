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
