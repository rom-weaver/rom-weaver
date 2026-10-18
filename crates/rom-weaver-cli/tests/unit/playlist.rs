use std::path::PathBuf;

use super::{disc_number, order_discs, relative_playlist_path, render_m3u};

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
