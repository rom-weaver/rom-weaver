use std::path::PathBuf;

use super::{
    disc_number, natural_cmp, order_discs, relative_playlist_path, render_m3u, staged_file_name,
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
fn staged_file_name_matches_the_browser_staging_rules() {
    for (name, expected) in [
        ("Game (Disc 1).bin", "Game (Disc 1).bin"),
        ("Pokémon (Disc 1).bin", "Pok_mon (Disc 1).bin"),
        ("日本語 (Disc 1).bin", "(Disc 1).bin"),
        ("A:B*C.bin", "A_B_C.bin"),
        (".hidden.bin", "hidden.bin"),
        // Separate passes, as in the browser: a non-ASCII run beside a reserved
        // character gives two underscores (checked against the TS function).
        ("Café: Disc 1.bin", "Caf__ Disc 1.bin"),
        ("Pokémon™: Disc 1.bin", "Pok_mon__ Disc 1.bin"),
        // The browser normalizes twice, with a `disc.bin` fallback on the first
        // pass, so a name that is only non-ASCII becomes `disc.bin` and `é.bin`
        // loses its dot to the second pass (checked against the TS function).
        ("", "disc.bin"),
        ("日本語", "disc.bin"),
        ("é.bin", "bin"),
        ("ときめき.bin", "bin"),
        ("a\u{1}é.bin", "a__.bin"),
    ] {
        assert_eq!(staged_file_name(name), expected, "{name}");
    }
}
