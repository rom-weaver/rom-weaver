use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use super::{
    BundleOptions, BundleSource, Companion, PlannedDisc, PlaylistCommand, PlaylistLayout,
    checked_game_name, disc_number, game_name, natural_cmp, order_discs, plan_bundle, plan_job,
    relative_playlist_path, renamed_companions, render_m3u, sheet_track_path,
};

fn names(paths: Vec<PathBuf>) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn disc_number_reads_the_naming_styles_seen_in_the_wild() {
    for (name, expected) in [
        ("Game (Disc 1).cue", Some(1)),
        ("Game (Disc 2 of 3).chd", Some(2)),
        ("Game [Disk 3].iso", Some(3)),
        ("Game - Disc2.cue", Some(2)),
        ("Game_Disc_4.cue", Some(4)),
        ("Game (CD1).cue", Some(1)),
        ("Game.disc02.cue", Some(2)),
        ("GAME.DISC10.CUE", Some(10)),
        ("Game.cue", None),
        ("Abcd1.cue", None),
        ("Disc.cue", None),
        ("Discovery 5.cue", None),
    ] {
        assert_eq!(disc_number(name), expected, "{name}");
    }
}

#[test]
fn discs_sort_numerically_not_lexically() {
    let sorted = order_discs(
        [
            "Game (Disc 10).chd",
            "Game (Disc 2).chd",
            "Game (Disc 1).chd",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect(),
    );
    assert_eq!(
        names(sorted),
        [
            "Game (Disc 1).chd",
            "Game (Disc 2).chd",
            "Game (Disc 10).chd"
        ]
    );
}

#[test]
fn unnumbered_files_follow_numbered_ones_in_name_order() {
    let sorted = order_discs(
        ["b.iso", "Game.disc02.iso", "a.iso", "Game.disc01.iso"]
            .into_iter()
            .map(PathBuf::from)
            .collect(),
    );
    assert_eq!(
        names(sorted),
        ["Game.disc01.iso", "Game.disc02.iso", "a.iso", "b.iso"]
    );
}

#[test]
fn equal_disc_numbers_fall_back_to_name_order() {
    let sorted = order_discs(
        ["B (Disc 1).iso", "A (Disc 1).iso"]
            .into_iter()
            .map(PathBuf::from)
            .collect(),
    );
    assert_eq!(names(sorted), ["A (Disc 1).iso", "B (Disc 1).iso"]);
}

#[test]
fn same_named_discs_keep_their_input_order() {
    let sorted = order_discs(
        [
            "b/Game (Disc 1).cue",
            "a/Game (Disc 1).cue",
            "c/Game (Disc 1).cue",
        ]
        .map(PathBuf::from)
        .to_vec(),
    );
    assert_eq!(
        sorted,
        [
            "b/Game (Disc 1).cue",
            "a/Game (Disc 1).cue",
            "c/Game (Disc 1).cue"
        ]
        .map(PathBuf::from)
    );
}

#[test]
fn natural_order_ignores_case_and_leading_zeros_and_orders_by_code_point() {
    use std::cmp::Ordering::{Equal, Greater, Less};
    for (left, right, expected) in [
        ("Disc 2", "Disc 10", Less),
        ("Disc 02", "disc 2", Equal),
        ("Disc 007", "Disc 8", Less),
        ("a0b", "a00b", Equal),
        ("a", "ab", Less),
        ("Zed", "aa", Greater),
        ("Pokémon", "Pokemon", Greater),
        ("日本1", "日本2", Less),
        ("x12", "x1y", Greater),
        ("", "a", Less),
    ] {
        assert_eq!(natural_cmp(left, right), expected, "{left} vs {right}");
        assert_eq!(
            natural_cmp(right, left),
            expected.reverse(),
            "{right} vs {left}"
        );
    }
}

#[test]
fn m3u_is_one_line_per_disc_with_a_trailing_newline() {
    let text = render_m3u(&["Game.disc01.cue".to_string(), "Game.disc02.cue".to_string()]);
    assert_eq!(text, "Game.disc01.cue\nGame.disc02.cue\n");
}

#[test]
fn relative_paths_use_forward_slashes_and_climb_with_dotdot() {
    let base = PathBuf::from("/games/out");
    assert_eq!(
        relative_playlist_path(&base, &PathBuf::from("/games/out/Game.cue")).unwrap(),
        "Game.cue"
    );
    assert_eq!(
        relative_playlist_path(&base, &PathBuf::from("/games/discs/sub/Game.cue")).unwrap(),
        "../discs/sub/Game.cue"
    );
    assert_eq!(
        relative_playlist_path(&base, &PathBuf::from("/games/out/./x/../Game.cue")).unwrap(),
        "Game.cue"
    );
}

#[test]
fn sheet_tracks_require_exact_original_names_in_the_staging_map() {
    let staged_paths = BTreeMap::from([
        (
            PathBuf::from("/work/_Track.bin"),
            PathBuf::from("/work/Track.bin"),
        ),
        (
            PathBuf::from("/work/Pokémon.bin"),
            PathBuf::from("/work/Pokémon.bin"),
        ),
    ]);
    for name in ["_Track.bin", "./_Track.bin"] {
        assert_eq!(
            sheet_track_path(Path::new("/work"), name, &staged_paths),
            Some(PathBuf::from("/work/Track.bin"))
        );
    }
    assert_eq!(
        sheet_track_path(Path::new("/work"), "Pokémon.bin", &staged_paths),
        Some(PathBuf::from("/work/Pokémon.bin"))
    );
    assert_eq!(
        sheet_track_path(Path::new("/work"), "Track.bin", &staged_paths),
        None
    );
    let unrelated = BTreeMap::from([(
        PathBuf::from("/work/Track.bin"),
        PathBuf::from("/work/Track.bin"),
    )]);
    assert_eq!(
        sheet_track_path(Path::new("/work"), "_Track.bin", &unrelated),
        None
    );
}

#[test]
fn native_sheet_tracks_keep_the_exact_reference() {
    assert_eq!(
        sheet_track_path(Path::new("/work"), "_Track.bin", &BTreeMap::new()),
        Some(PathBuf::from("/work/_Track.bin"))
    );
}

#[test]
fn game_name_drops_the_extension_and_disc_marker() {
    for (name, expected) in [
        (
            "Final Fantasy VII (USA) (Disc 1).cue",
            "Final Fantasy VII (USA)",
        ),
        (
            "Resident Evil (2000)(Capcom)(US)(Disc 1 of 2)[!].gdi",
            "Resident Evil (2000)(Capcom)(US)[!]",
        ),
        ("Game (Disc 2) (Rev 1).chd", "Game (Rev 1)"),
        ("Game [Disk 3].iso", "Game"),
        ("Game - Disc2.cue", "Game"),
        ("Game_Disc_4.cue", "Game"),
        ("Game (CD1).cue", "Game"),
        ("Game.disc02.cue", "Game"),
        ("Disc 1 - Game.iso", "Game"),
        ("Pokémon (Disc 1 OF 2).chd", "Pokémon"),
        ("Game.cue", "Game"),
        ("Disc 1.cue", ""),
    ] {
        assert_eq!(game_name(name), expected, "{name}");
    }
}

#[test]
fn game_names_must_be_one_path_component() {
    assert_eq!(
        checked_game_name("  Game (USA) "),
        Some("Game (USA)".to_string())
    );
    for bad in ["", " ", ".", "..", "a/b", "a\\b", "say \"hi\"", "tab\there"] {
        assert_eq!(checked_game_name(bad), None, "{bad:?}");
    }
}

fn companion(name: &str, reference: bool) -> Companion {
    Companion {
        source: PathBuf::from("/in").join(name),
        name: name.to_string(),
        reference: reference.then(|| name.to_string()),
    }
}

#[test]
fn renamed_tracks_follow_the_disc_and_pad_to_the_track_count() {
    let disc = |companions| PlannedDisc {
        path: PathBuf::from("/in/x.cue"),
        companions,
    };
    assert_eq!(
        renamed_companions(&disc(vec![companion("a.bin", true)]), "G (Disc 1)"),
        ["G (Disc 1).bin"]
    );
    let many: Vec<_> = (1..=10)
        .map(|track| {
            companion(
                &format!("t{track}.{}", if track == 2 { "wav" } else { "bin" }),
                true,
            )
        })
        .collect();
    let names = renamed_companions(&disc(many), "G (Disc 2)");
    assert_eq!(names[0], "G (Disc 2) (Track 01).bin");
    assert_eq!(names[1], "G (Disc 2) (Track 02).wav");
    assert_eq!(names[9], "G (Disc 2) (Track 10).bin");
    assert_eq!(
        renamed_companions(
            &disc(vec![companion("x.IMG", false), companion("x.sub", false)]),
            "G (Disc 1)"
        ),
        ["G (Disc 1).IMG", "G (Disc 1).sub"]
    );
}

#[test]
fn each_layout_places_the_playlist_discs_and_tracks() {
    let discs = || {
        ["Game (Disc 1).chd", "Game (Disc 2).chd"]
            .map(|name| PlannedDisc {
                path: PathBuf::from("/in").join(name),
                companions: vec![companion("track01.bin", false)],
            })
            .into_iter()
            .collect::<Vec<_>>()
    };
    for (layout, playlist, first_disc, first_track, first_line) in [
        (
            PlaylistLayout::Flat,
            "Game.m3u",
            "Game (Disc 1).chd",
            "track01.bin",
            "Game (Disc 1).chd",
        ),
        (
            PlaylistLayout::Folder,
            "Game/Game.m3u",
            "Game/Game (Disc 1).chd",
            "Game/track01.bin",
            "Game (Disc 1).chd",
        ),
        (
            PlaylistLayout::M3uFolder,
            "Game.m3u/Game.m3u",
            "Game.m3u/Game (Disc 1).chd",
            "Game.m3u/track01.bin",
            "Game (Disc 1).chd",
        ),
        (
            PlaylistLayout::DiscFolders,
            "Game.m3u",
            "Game (Disc 1)/Game (Disc 1).chd",
            "Game (Disc 1)/track01.bin",
            "Game (Disc 1)/Game (Disc 1).chd",
        ),
    ] {
        let options = BundleOptions {
            layout,
            rename: false,
            chd: false,
        };
        let (lines, entries) = plan_bundle(&discs(), "Game", options).unwrap();
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths[..2], [playlist, first_disc], "{layout:?}");
        assert_eq!(paths[3], first_track, "{layout:?}");
        assert_eq!(lines[0], first_line, "{layout:?}");
        let BundleSource::Text(text) = &entries[0].source else {
            panic!("the playlist is generated text");
        };
        assert_eq!(text, &render_m3u(&lines));
    }
}

#[test]
fn rename_numbers_discs_in_playlist_order_and_refuses_mds() {
    let discs: Vec<_> = ["b.chd", "a.chd"]
        .map(|name| PlannedDisc {
            path: PathBuf::from("/in").join(name),
            companions: Vec::new(),
        })
        .into_iter()
        .collect();
    let options = BundleOptions {
        layout: PlaylistLayout::Flat,
        rename: true,
        chd: false,
    };
    let (lines, _) = plan_bundle(&discs, "FF7", options).unwrap();
    assert_eq!(lines, ["FF7 (Disc 1).chd", "FF7 (Disc 2).chd"]);
    let mds = [PlannedDisc {
        path: PathBuf::from("/in/x.mds"),
        companions: vec![companion("x.mdf", false)],
    }];
    assert!(plan_bundle(&mds, "FF7", options).is_err());
}

#[test]
fn sheet_tracks_take_one_staged_file_differing_only_in_case() {
    let staged_paths = BTreeMap::from([
        (
            PathBuf::from("/work/Game.bin"),
            PathBuf::from("/staged/Game.bin"),
        ),
        (
            PathBuf::from("/work/sub/GAME.BIN"),
            PathBuf::from("/staged/sub/GAME.BIN"),
        ),
    ]);
    assert_eq!(
        sheet_track_path(Path::new("/work"), "GAME.BIN", &staged_paths),
        Some(PathBuf::from("/staged/Game.bin"))
    );
    let ambiguous = BTreeMap::from([
        (
            PathBuf::from("/work/Game.bin"),
            PathBuf::from("/work/Game.bin"),
        ),
        (
            PathBuf::from("/work/game.BIN"),
            PathBuf::from("/work/game.BIN"),
        ),
    ]);
    assert_eq!(
        sheet_track_path(Path::new("/work"), "GAME.bin", &ambiguous),
        None
    );
}

fn write_cue_disc(dir: &Path, stem: &str, tracks: &[&str]) {
    let mut sheet = String::new();
    for (index, track) in tracks.iter().enumerate() {
        fs::write(dir.join(track), track.as_bytes()).expect("write track");
        sheet.push_str(&format!(
            "FILE \"{track}\" BINARY\n  TRACK {:02} MODE2/2352\n    INDEX 01 00:00:00\n",
            index + 1
        ));
    }
    fs::write(dir.join(format!("{stem}.cue")), sheet).expect("write cue");
}

fn in_place_args(dir: &Path, inputs: &[&str], name: Option<&str>) -> PlaylistCommand {
    PlaylistCommand {
        staged_paths: BTreeMap::new(),
        input: inputs.iter().map(|input| dir.join(input)).collect(),
        output: None,
        name: name.map(str::to_string),
        layout: PlaylistLayout::Flat,
        rename: false,
        chd: false,
        no_sort: false,
        flat: false,
        codec: None,
        rename_in_place: true,
    }
}

#[test]
fn rename_in_place_renames_discs_tracks_and_same_named_files() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    for stem in ["ff7.disc02", "ff7.disc01"] {
        write_cue_disc(temp.path(), stem, &[&format!("{stem}.bin")]);
        fs::write(temp.path().join(format!("{stem}.sbi")), b"sbi").expect("write sbi");
    }
    fs::write(temp.path().join("notes.txt"), b"keep").expect("write notes");
    fs::write(temp.path().join("ff7.disc01.m3u"), b"old").expect("write old playlist");
    let plan = plan_job(&in_place_args(
        temp.path(),
        &["ff7.disc02.cue", "ff7.disc01.cue"],
        Some("Final Fantasy VII"),
    ))
    .expect("plan")
    .dry_run_plan();
    assert_eq!(plan.file_name, "Final Fantasy VII.m3u");
    assert_eq!(
        plan.entries,
        [
            "Final Fantasy VII (Disc 1).cue",
            "Final Fantasy VII (Disc 2).cue"
        ]
    );
    assert_eq!(plan.text, render_m3u(&plan.entries));
    let renames: Vec<(String, &str, bool)> = plan
        .renames
        .iter()
        .map(|rename| {
            (
                Path::new(&rename.from)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                rename.to.as_str(),
                rename.text.is_some(),
            )
        })
        .collect();
    let expected = [
        ("ff7.disc01.cue", "Final Fantasy VII (Disc 1).cue", true),
        ("ff7.disc02.cue", "Final Fantasy VII (Disc 2).cue", true),
        ("ff7.disc01.bin", "Final Fantasy VII (Disc 1).bin", false),
        ("ff7.disc02.bin", "Final Fantasy VII (Disc 2).bin", false),
        ("ff7.disc01.sbi", "Final Fantasy VII (Disc 1).sbi", false),
        ("ff7.disc02.sbi", "Final Fantasy VII (Disc 2).sbi", false),
    ]
    .map(|(from, to, text)| (from.to_string(), to, text));
    assert_eq!(renames, expected);
    assert!(
        plan.renames[0]
            .text
            .as_deref()
            .is_some_and(|text| text.contains("FILE \"Final Fantasy VII (Disc 1).bin\" BINARY")),
        "the renamed sheet names its renamed track"
    );
}

fn in_place_refusal(setup: impl Fn(&Path), inputs: &[&str], name: Option<&str>) -> String {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    fs::create_dir(temp.path().join("sub")).expect("sub folder");
    setup(temp.path());
    match plan_job(&in_place_args(temp.path(), inputs, name)) {
        Ok(_) => panic!("planned renaming {inputs:?} in place"),
        Err(error) => error.to_string(),
    }
}

#[test]
fn rename_in_place_refuses_what_a_rename_could_lose_or_overwrite() {
    let chd = |dir: &Path, names: &[&str]| {
        for name in names {
            fs::write(dir.join(name), b"chd").expect("write disc");
        }
    };
    for (setup, inputs, name, message) in [
        (
            Box::new(move |dir: &Path| chd(dir, &["G (Disc 2).chd", "G (Disc 3).chd"]))
                as Box<dyn Fn(&Path)>,
            &["G (Disc 2).chd", "G (Disc 3).chd"][..],
            None,
            "needs discs numbered 1 to 2; `G (Disc 2).chd` would become Disc 1",
        ),
        (
            Box::new(move |dir: &Path| {
                chd(dir, &["a (Disc 1).chd", "a (Disc 2).chd", "G (Disc 1).chd"])
            }),
            &["a (Disc 1).chd", "a (Disc 2).chd"][..],
            Some("G"),
            "`G (Disc 1).chd` already exists beside the discs",
        ),
        (
            Box::new(move |dir: &Path| chd(dir, &["a (Disc 1).chd", "a (Disc 2).chd", "g.M3U"])),
            &["a (Disc 1).chd", "a (Disc 2).chd"][..],
            Some("G"),
            "`G.m3u` already exists beside the discs",
        ),
        (
            Box::new(move |dir: &Path| chd(dir, &["a (Disc 1).chd", "sub/a (Disc 2).chd"])),
            &["a (Disc 1).chd", "sub/a (Disc 2).chd"][..],
            None,
            "needs every disc and track file in one folder",
        ),
        (
            Box::new(move |dir: &Path| {
                write_cue_disc(dir, "a (Disc 1)", &["shared.bin"]);
                write_cue_disc(dir, "a (Disc 2)", &["shared.bin"]);
            }),
            &["a (Disc 1).cue", "a (Disc 2).cue"][..],
            None,
            "`shared.bin` belongs to two discs",
        ),
        (
            Box::new(move |dir: &Path| {
                write_cue_disc(
                    dir,
                    "a (Disc 1)",
                    &["a (Disc 1).bin", "a (Disc 1) (Track 2).bin"],
                );
                fs::write(dir.join("a (Disc 1).sbi"), b"sbi").expect("write sbi");
            }),
            &["a (Disc 1).cue"][..],
            Some("G"),
            "`a (Disc 1).sbi` shares its name with files that get different names",
        ),
    ] {
        let error = in_place_refusal(setup, inputs, name);
        assert!(error.contains(message), "{inputs:?}: {error}");
    }
}

fn bundle_args(dir: &Path, output: &str, rename: bool, codec: Option<&str>) -> PlaylistCommand {
    PlaylistCommand {
        output: Some(dir.join(output)),
        rename,
        codec: codec.map(str::to_string),
        rename_in_place: false,
        ..in_place_args(dir, &["Game CD2.cue", "Game CD1.cue"], Some("Game"))
    }
}

#[test]
fn zip_plan_lists_each_file_with_its_source_and_rewritten_sheet() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    for stem in ["Game CD1", "Game CD2"] {
        write_cue_disc(temp.path(), stem, &[&format!("{stem}.bin")]);
    }
    let plan = plan_job(&bundle_args(temp.path(), "Game.zip", true, None))
        .expect("plan")
        .dry_run_plan();
    assert_eq!(plan.bundle[0].path, "Game.m3u");
    assert!(plan.bundle[0].source.is_none() && plan.bundle[0].text.is_none());
    let mut paths: Vec<_> = plan.bundle[1..]
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        [
            "Game (Disc 1).bin",
            "Game (Disc 1).cue",
            "Game (Disc 2).bin",
            "Game (Disc 2).cue"
        ]
    );
    let file = |path: &str| {
        plan.bundle
            .iter()
            .find(|file| file.path == path)
            .expect(path)
    };
    let source_name = |path: &str| {
        let source = file(path).source.as_ref().expect("source");
        Path::new(source)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    assert_eq!(source_name("Game (Disc 1).cue"), "Game CD1.cue");
    assert_eq!(source_name("Game (Disc 1).bin"), "Game CD1.bin");
    assert!(
        file("Game (Disc 1).cue")
            .text
            .as_deref()
            .is_some_and(|text| text.contains("FILE \"Game (Disc 1).bin\""))
    );
    assert!(file("Game (Disc 1).bin").text.is_none());
}

#[test]
fn only_a_zip_or_folder_plan_lists_a_bundle() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    for stem in ["Game CD1", "Game CD2"] {
        write_cue_disc(temp.path(), stem, &[&format!("{stem}.bin")]);
    }
    let mut m3u = bundle_args(temp.path(), "Game.m3u", false, None);
    m3u.name = None;
    let in_place = in_place_args(temp.path(), &["Game CD1.cue", "Game CD2.cue"], Some("Game"));
    for args in [m3u, in_place] {
        let plan = plan_job(&args).expect("plan").dry_run_plan();
        assert!(plan.bundle.is_empty(), "{:?}", plan.bundle);
    }
    let folder = plan_job(&bundle_args(temp.path(), "out", false, None))
        .expect("plan")
        .dry_run_plan();
    assert_eq!(folder.bundle.len(), 5);
}

#[test]
fn codec_needs_a_zip_output() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    for stem in ["Game CD1", "Game CD2"] {
        write_cue_disc(temp.path(), stem, &[&format!("{stem}.bin")]);
    }
    assert!(plan_job(&bundle_args(temp.path(), "Game.zip", false, Some("store"))).is_ok());
    for output in ["out", "Game.m3u"] {
        let mut args = bundle_args(temp.path(), output, false, Some("store"));
        args.name = None;
        let error = plan_job(&args).err().expect("refused").to_string();
        assert!(error.contains("--codec"), "{output}: {error}");
    }
}

/// A one-track CD: a `.cue` naming a `.bin` of whole 2352-byte sectors.
fn write_cd_disc(dir: &Path, stem: &str) {
    fs::write(dir.join(format!("{stem}.bin")), vec![0_u8; 4 * 2352]).expect("write track");
    fs::write(
        dir.join(format!("{stem}.cue")),
        format!("FILE \"{stem}.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n"),
    )
    .expect("write cue");
}

fn chd_args(dir: &Path, output: &str, inputs: &[&str], rename: bool) -> PlaylistCommand {
    PlaylistCommand {
        input: inputs.iter().map(|input| dir.join(input)).collect(),
        chd: true,
        ..bundle_args(dir, output, rename, None)
    }
}

#[test]
fn chd_plan_lists_one_chd_per_disc_without_its_tracks() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    write_cd_disc(temp.path(), "Game CD1");
    fs::write(temp.path().join("Game CD2.chd"), b"chd").expect("write chd");
    let inputs = ["Game CD2.chd", "Game CD1.cue"];
    for (rename, first, second) in [
        (true, "Game (Disc 1).chd", "Game (Disc 2).chd"),
        (false, "Game CD1.chd", "Game CD2.chd"),
    ] {
        let plan = plan_job(&chd_args(temp.path(), "Game.zip", &inputs, rename))
            .expect("plan")
            .dry_run_plan();
        let files: Vec<(&str, String)> = plan
            .bundle
            .iter()
            .map(|file| {
                let source = file.source.as_deref().map(Path::new);
                let source_name = source.and_then(Path::file_name).unwrap_or_default();
                (
                    file.path.as_str(),
                    source_name.to_string_lossy().into_owned(),
                )
            })
            .collect();
        assert_eq!(
            files,
            [
                ("Game.m3u", String::new()),
                (first, "Game CD1.cue".to_string()),
                (second, "Game CD2.chd".to_string()),
            ],
            "rename: {rename}"
        );
        assert_eq!(plan.entries, [first, second], "rename: {rename}");
    }
}

#[test]
fn chd_refuses_discs_it_cannot_compress_and_outputs_that_do_not_copy() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    write_cd_disc(temp.path(), "Game CD1");
    write_cd_disc(temp.path(), "Game CD2");
    fs::write(temp.path().join("Game CD2.chd"), b"chd").expect("write chd");
    fs::write(temp.path().join("Game CD3.pbp"), b"PBP").expect("write pbp");
    fs::write(temp.path().join("Game CD3.iso"), vec![0_u8; 1000]).expect("write iso");
    let mut m3u = chd_args(temp.path(), "Game.m3u", &["Game CD1.cue"], false);
    m3u.name = None;
    let mut in_place = chd_args(temp.path(), "unused", &["Game CD1.cue"], false);
    in_place.output = None;
    in_place.rename_in_place = true;
    for (args, message) in [
        (
            chd_args(
                temp.path(),
                "Game.zip",
                &["Game CD1.cue", "Game CD3.pbp"],
                false,
            ),
            "--chd cannot compress `Game CD3.pbp`",
        ),
        (
            chd_args(temp.path(), "out", &["Game CD1.cue", "Game CD3.iso"], false),
            "--chd cannot compress `Game CD3.iso`",
        ),
        (
            chd_args(
                temp.path(),
                "Game.zip",
                &["Game CD2.cue", "Game CD2.chd"],
                false,
            ),
            "two files would both be written as `Game CD2.chd`",
        ),
        (m3u, "--chd copy the discs"),
        (in_place, "--chd"),
    ] {
        let error = plan_job(&args).err().expect("refused").to_string();
        assert!(error.contains(message), "{:?}: {error}", args.input);
    }
}
