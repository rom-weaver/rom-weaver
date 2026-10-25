use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use super::{
    BundleSource, Companion, PlannedDisc, PlaylistLayout, checked_game_name, disc_number,
    game_name, natural_cmp, order_discs, plan_bundle, relative_playlist_path, renamed_companions,
    render_m3u, sheet_track_path,
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
        let (lines, entries) = plan_bundle(&discs(), "Game", layout, false).unwrap();
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
    let (lines, _) = plan_bundle(&discs, "FF7", PlaylistLayout::Flat, true).unwrap();
    assert_eq!(lines, ["FF7 (Disc 1).chd", "FF7 (Disc 2).chd"]);
    let mds = [PlannedDisc {
        path: PathBuf::from("/in/x.mds"),
        companions: vec![companion("x.mdf", false)],
    }];
    assert!(plan_bundle(&mds, "FF7", PlaylistLayout::Flat, true).is_err());
}
