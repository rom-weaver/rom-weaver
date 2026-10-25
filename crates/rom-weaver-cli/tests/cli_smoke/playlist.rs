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
fn playlist_keeps_an_unrelated_disc_with_a_companion_basename() {
    let temp = setup_temp_dir();
    let a = temp.child("a");
    let b = temp.child("b");
    fs::create_dir_all(a.path()).expect("a folder");
    fs::create_dir_all(b.path()).expect("b folder");
    let cue = a.child("Disc1.cue");
    let track = a.child("Track.bin");
    let independent = b.child("Track.bin");
    fs::write(
        cue.path(),
        b"FILE \"Track.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    )
    .expect("cue");
    fs::write(track.path(), b"companion").expect("track");
    fs::write(independent.path(), b"independent disc").expect("disc");
    let out = temp.child("Game.m3u");
    run_single_json_event(
        &playlist_args(
            &[
                cue.path().to_str().expect("p"),
                track.path().to_str().expect("p"),
                independent.path().to_str().expect("p"),
            ],
            out.path().to_str().expect("p"),
            &["--no-sort"],
        ),
        0,
    );
    assert_eq!(
        fs::read_to_string(out.path()).expect("m3u"),
        "a/Disc1.cue\nb/Track.bin\n"
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
fn playlist_zip_requires_the_exact_track_name() {
    let temp = setup_temp_dir();
    for (sheet, track) in [("Disc1.cue", "_Track.bin"), ("Disc2.cue", "Track.bin")] {
        fs::write(
            temp.path().join(sheet),
            format!("FILE \"{track}\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n"),
        )
        .expect("cue");
    }
    fs::write(temp.child("Track.bin").path(), b"B").expect("unrelated track");
    let inputs: Vec<String> = ["Disc1.cue", "Disc2.cue", "Track.bin"]
        .iter()
        .map(|name| temp.path().join(name).to_str().unwrap().to_string())
        .collect();
    let refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
    let out = temp.child("Game.zip");
    let event = run_single_json_event(&playlist_args(&refs, out.path().to_str().unwrap(), &[]), 1);
    assert!(event.to_string().contains("_Track.bin"), "{event}");
    assert!(event.to_string().contains("missing"), "{event}");
    assert!(!out.path().exists());
}

#[test]
fn playlist_zip_keeps_exact_underscore_and_unicode_track_bytes() {
    let temp = setup_temp_dir();
    for stem in ["_Track", "Pokémon", "日本語"] {
        write_cue_disc(temp.path(), stem);
    }
    let inputs: Vec<String> = ["_Track", "Pokémon", "日本語"]
        .iter()
        .flat_map(|stem| [format!("{stem}.cue"), format!("{stem}.bin")])
        .map(|name| temp.path().join(name).to_str().unwrap().to_string())
        .collect();
    let refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
    let out = temp.child("Game.zip");
    run_single_json_event(&playlist_args(&refs, out.path().to_str().unwrap(), &[]), 0);
    let extracted = temp.child("unzipped");
    command_stdout(
        &[
            "extract",
            "--input",
            out.path().to_str().unwrap(),
            "--output",
            extracted.path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    for stem in ["_Track", "Pokémon", "日本語"] {
        assert_eq!(
            fs::read(extracted.child(format!("{stem}.bin")).path()).unwrap(),
            stem.as_bytes()
        );
    }
    let playlist = fs::read_to_string(extracted.child("Game.m3u").path()).unwrap();
    assert_eq!(playlist.lines().count(), 3);
    for stem in ["_Track", "Pokémon", "日本語"] {
        assert!(playlist.lines().any(|line| line == format!("{stem}.cue")));
    }
}

/// A TOSEC-style GD-ROM disc: every disc's tracks share the names `track01.bin`...
fn write_gdi_disc(dir: &Path, stem: &str) {
    fs::create_dir_all(dir).expect("disc dir");
    fs::write(
        dir.join(format!("{stem}.gdi")),
        "3\n1 0 4 2352 track01.bin 0\n2 450 0 2352 track02.raw 0\n3 45000 4 2352 track03.bin 0\n",
    )
    .expect("gdi");
    for track in ["track01.bin", "track02.raw", "track03.bin"] {
        fs::write(dir.join(track), format!("{stem}/{track}")).expect("track");
    }
}

fn extract_zip(zip: &Path, into: &Path) {
    command_stdout(
        &[
            "extract",
            "--input",
            zip.to_str().expect("p"),
            "--output",
            into.to_str().expect("p"),
            "--json",
        ],
        0,
    );
}

#[test]
fn playlist_zip_disc_folders_keep_same_named_tracks_apart() {
    let temp = setup_temp_dir();
    let stems = ["Game (Disc 1 of 2)[!]", "Game (Disc 2 of 2)[!]"];
    for stem in stems {
        write_gdi_disc(&temp.path().join(stem), stem);
    }
    let gdi = |stem: &str| temp.path().join(stem).join(format!("{stem}.gdi"));
    let (one, two) = (gdi(stems[0]), gdi(stems[1]));
    let flat = temp.child("Flat.zip");
    let event = run_single_json_event(
        &playlist_args(
            &[two.to_str().expect("p"), one.to_str().expect("p")],
            flat.path().to_str().expect("p"),
            &[],
        ),
        1,
    );
    assert!(event.to_string().contains("track01.bin"), "{event}");
    let out = temp.child("Game.zip");
    run_single_json_event(
        &playlist_args(
            &[two.to_str().expect("p"), one.to_str().expect("p")],
            out.path().to_str().expect("p"),
            &["--layout", "disc-folders"],
        ),
        0,
    );
    let unzipped = temp.child("unzipped");
    extract_zip(out.path(), unzipped.path());
    assert_eq!(
        fs::read_to_string(unzipped.child("Game.m3u").path()).expect("m3u"),
        format!("{0}/{0}.gdi\n{1}/{1}.gdi\n", stems[0], stems[1])
    );
    for stem in stems {
        for track in ["track01.bin", "track02.raw", "track03.bin"] {
            assert_eq!(
                fs::read_to_string(unzipped.path().join(stem).join(track)).expect("track"),
                format!("{stem}/{track}")
            );
        }
    }
}

#[test]
fn playlist_folder_output_copies_each_layout_and_never_overwrites() {
    let temp = setup_temp_dir();
    let discs = temp.child("discs");
    fs::create_dir_all(discs.path()).expect("discs dir");
    for stem in ["FF (USA) (Disc 2)", "FF (USA) (Disc 1)"] {
        write_cue_disc(discs.path(), stem);
    }
    let cue = |stem: &str| discs.path().join(format!("{stem}.cue"));
    let (two, one) = (cue("FF (USA) (Disc 2)"), cue("FF (USA) (Disc 1)"));
    let inputs = [two.to_str().expect("p"), one.to_str().expect("p")];
    let lines = "FF (USA) (Disc 1).cue\nFF (USA) (Disc 2).cue\n";
    for (layout, folder) in [("folder", "FF (USA)"), ("m3u-folder", "FF (USA).m3u")] {
        let roms = temp.child(format!("roms-{layout}"));
        let json = run_single_json_event(
            &playlist_args(
                &inputs,
                roms.path().to_str().expect("p"),
                &["--layout", layout],
            ),
            0,
        );
        assert_eq!(json["status"], "succeeded");
        let game = roms.path().join(folder);
        assert_eq!(
            fs::read_to_string(game.join("FF (USA).m3u")).expect("m3u"),
            lines,
            "{layout}"
        );
        for name in ["FF (USA) (Disc 1).bin", "FF (USA) (Disc 2).cue"] {
            assert_eq!(
                fs::read(game.join(name)).expect("copied"),
                fs::read(discs.path().join(name)).expect("source"),
                "{layout} {name}"
            );
        }
        let again = run_single_json_event(
            &playlist_args(
                &inputs,
                roms.path().to_str().expect("p"),
                &["--layout", layout],
            ),
            1,
        );
        assert!(
            again.to_string().contains("refusing to overwrite"),
            "{again}"
        );
    }
}

#[test]
fn playlist_rename_names_discs_and_rewrites_their_sheets() {
    let temp = setup_temp_dir();
    fs::write(temp.path().join("b1.bin"), b"track one").expect("bin");
    fs::write(temp.path().join("b2.wav"), b"track two").expect("wav");
    fs::write(
        temp.path().join("first.cue"),
        "FILE b1.bin BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE \"b2.wav\" WAVE\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n",
    )
    .expect("cue");
    write_cue_disc(temp.path(), "second");
    let out = temp.child("roms");
    let first = temp.path().join("first.cue");
    let second = temp.path().join("second.cue");
    run_single_json_event(
        &playlist_args(
            &[first.to_str().expect("p"), second.to_str().expect("p")],
            &format!("{}/", out.path().to_str().expect("p")),
            &["--no-sort", "--rename", "--name", "Game"],
        ),
        0,
    );
    assert_eq!(
        fs::read_to_string(out.child("Game.m3u").path()).expect("m3u"),
        "Game (Disc 1).cue\nGame (Disc 2).cue\n"
    );
    assert_eq!(
        fs::read_to_string(out.child("Game (Disc 1).cue").path()).expect("cue"),
        "FILE \"Game (Disc 1) (Track 1).bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE \"Game (Disc 1) (Track 2).wav\" WAVE\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n"
    );
    assert_eq!(
        fs::read(out.child("Game (Disc 1) (Track 2).wav").path()).expect("wav"),
        b"track two"
    );
    assert_eq!(
        fs::read_to_string(out.child("Game (Disc 2).cue").path()).expect("cue"),
        "FILE \"Game (Disc 2).bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n"
    );
    assert_eq!(
        fs::read(out.child("Game (Disc 2).bin").path()).expect("bin"),
        b"second"
    );
    assert_eq!(
        fs::read_to_string(&first).expect("source cue"),
        "FILE b1.bin BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE \"b2.wav\" WAVE\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n",
        "the source sheet is never edited"
    );
}

#[test]
fn playlist_without_output_writes_the_game_playlist_beside_the_first_disc() {
    let temp = setup_temp_dir();
    for name in ["Game (USA) (Disc 2).chd", "Game (USA) (Disc 1).chd"] {
        fs::write(temp.path().join(name), b"chd").expect("disc");
    }
    let two = temp.path().join("Game (USA) (Disc 2).chd");
    let one = temp.path().join("Game (USA) (Disc 1).chd");
    let json = run_single_json_event(
        &[
            "playlist",
            "-i",
            two.to_str().expect("p"),
            "-i",
            one.to_str().expect("p"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read_to_string(temp.path().join("Game (USA).m3u")).expect("m3u"),
        "Game (USA) (Disc 1).chd\nGame (USA) (Disc 2).chd\n"
    );
}

#[test]
fn playlist_refuses_copy_options_for_a_lone_m3u() {
    let temp = setup_temp_dir();
    let disc = temp.child("Game (Disc 1).chd");
    fs::write(disc.path(), b"chd").expect("disc");
    let disc_path = disc.path().to_str().expect("p");
    let out = temp.child("Game.m3u");
    for extra in [
        &["--rename"][..],
        &["--layout", "folder"],
        &["--name", "Other"],
    ] {
        let json = run_single_json_event(
            &playlist_args(&[disc_path], out.path().to_str().expect("p"), extra),
            1,
        );
        assert_eq!(json["status"], "failed", "{extra:?}");
    }
    assert!(!out.path().exists());
    let json = run_single_json_event(
        &playlist_args(
            &[disc_path],
            temp.child("roms/").path().to_str().expect("p"),
            &["--name", "a/b"],
        ),
        1,
    );
    assert!(json.to_string().contains("--name"), "{json}");
}

#[test]
fn playlist_dry_run_lists_every_file_a_folder_output_writes() {
    let temp = setup_temp_dir();
    write_cue_disc(temp.path(), "Game (Disc 1)");
    let cue = temp.path().join("Game (Disc 1).cue");
    let roms = temp.child("roms");
    let json = run_single_json_event(
        &playlist_args(
            &[cue.to_str().expect("p")],
            roms.path().to_str().expect("p"),
            &["--layout", "folder", "--dry-run"],
        ),
        0,
    );
    let game = roms.path().join("Game");
    assert_eq!(
        json["details"]["writes"],
        serde_json::json!([
            game.join("Game.m3u").to_str().expect("p"),
            game.join("Game (Disc 1).cue").to_str().expect("p"),
            game.join("Game (Disc 1).bin").to_str().expect("p"),
        ])
    );
    assert!(!roms.path().exists(), "dry run must not write");
}
