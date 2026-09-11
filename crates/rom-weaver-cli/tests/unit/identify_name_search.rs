use rom_weaver_checksum::identify_catalog::IdentifySource;
use rom_weaver_checksum::identify_pack_types::{PackGame, UpstreamSource};

use super::*;

fn game(name: &str) -> PackGame {
    PackGame {
        name: name.to_string(),
        platform: "Test System".to_string(),
        source: IdentifySource::Libretro,
        upstream_source: UpstreamSource::Libretro,
        provenance: Vec::new(),
        legacy_variant: false,
        dump_tags: Vec::new(),
        alternate_names: Vec::new(),
        game_id: None,
        region: None,
        language: None,
        disc_number: None,
        revision: None,
        parent: None,
        components: Vec::new(),
    }
}

fn hit(query: &str, game: &PackGame) -> Option<i64> {
    let query = NameQuery::new(query).expect("a non-empty query");
    query.score(game, &mut SearchScratch::default())
}

fn title_hit(query: &str, title: &str) -> Option<i64> {
    let query = NameQuery::new(query).expect("a non-empty query");
    query.score_title(title, &mut SearchScratch::default())
}

fn title_system_hit(query: &str, title: &str, systems: &[&str]) -> Option<i64> {
    let query = NameQuery::new(query).expect("a non-empty query");
    let mut scratch = SearchScratch::default();
    let systems = query.score_systems(systems.iter().copied(), &mut scratch);
    query
        .score_title_with_system_match(title, &systems, &mut scratch)
        .map(|(score, _)| score)
}

fn names(query: &str, games: &[PackGame]) -> Vec<String> {
    let parsed = NameQuery::new(query).expect("a non-empty query");
    search_packs(&parsed, &[games])
        .into_iter()
        .map(|hit| games[hit.game].name.clone())
        .collect()
}

#[test]
fn normalization_collapses_punctuation_and_case() {
    assert_eq!(
        normalize("Super  Mario_World (USA)!"),
        "super mario world usa"
    );
    assert_eq!(normalize("---"), "");
}

#[test]
fn normalization_folds_accented_latin_letters_to_ascii() {
    // The shipped packs carry accented titles and the reader types ASCII, so
    // both sides MUST fold to the same text.
    assert_eq!(normalize("Astérix"), "asterix");
    assert_eq!(normalize("Pokémon Blaue Edition"), "pokemon blaue edition");
    // An umlaut folds to its base letter, not to the German two-letter
    // transliteration, so the fold matches the accented source spelling.
    assert_eq!(normalize("Grüße"), "grusse");
    assert_eq!(normalize("Ærø"), "aero");
    // A script with no ASCII base keeps its own characters, so a query typed
    // in that script still matches.
    assert_eq!(normalize("大戦"), "大戦");
}

#[test]
fn an_ascii_query_finds_an_accented_title() {
    let accented = game("Astérix and the Great Rescue");
    assert!(hit("asterix rescue", &accented).is_some());
    assert!(hit("astérix rescue", &accented).is_some());
}

#[test]
fn an_empty_query_is_rejected() {
    let error = NameQuery::new("!!! ---").expect_err("punctuation alone is no query");
    assert!(error.to_string().contains("--name"));
}

#[test]
fn a_query_matches_case_and_punctuation_insensitively() {
    assert!(hit("super mario world", &game("Super Mario World (USA)")).is_some());
    assert!(hit("SUPER-MARIO", &game("Super Mario World (USA)")).is_some());
}

#[test]
fn every_query_token_must_match() {
    assert!(hit("mario world", &game("Super Mario World (USA)")).is_some());
    assert!(
        hit("mario kart", &game("Super Mario World (USA)")).is_none(),
        "a token that matches nothing rejects the candidate"
    );
}

#[test]
fn title_scores_require_every_query_token() {
    assert!(title_hit("legend zelda", "The Legend of Zelda").is_some());
    assert!(title_hit("legend zelda", "Zelda II").is_none());
}

#[test]
fn title_scores_find_all_zelda_titles() {
    for title in ["The Legend of Zelda", "Zelda II: The Adventure of Link"] {
        assert!(title_hit("zelda", title).is_some(), "{title}");
    }
}

#[test]
fn title_scores_accept_bounded_typos_and_transpositions() {
    assert!(title_hit("zelda", "Zelad II").is_some());
    assert!(title_hit("adventure", "Adventxure").is_some());
    assert!(title_hit("adventure", "Adventxxure").is_some());
    assert!(title_hit("adventure", "Adventxxxure").is_none());
}

#[test]
fn title_scores_fold_unicode_before_fuzzy_matching() {
    assert!(title_hit("pokemno", "Pokémon Red").is_some());
}

#[test]
fn title_scores_match_canonical_system_names_and_aliases() {
    let systems = [
        "Nintendo Super Nintendo Entertainment System",
        "snes",
        "super nintendo",
        "super famicom",
    ];
    assert!(title_system_hit("mario snes", "Super Mario World", &systems).is_some());
    assert!(title_system_hit("super famicom mario", "Super Mario World", &systems).is_some());
    assert!(
        title_system_hit(
            "nintendo super nintendo entertainment system mario",
            "Super Mario World",
            &systems,
        )
        .is_some()
    );
}

#[test]
fn title_scores_allow_system_only_and_typo_queries() {
    let systems = ["Sony PlayStation", "playstation", "psx"];
    assert!(title_system_hit("playstation", "Final Fantasy VII", &systems).is_some());
    assert!(title_system_hit("final fantazy playstatoin", "Final Fantasy VII", &systems).is_some());
}

#[test]
fn short_and_numeric_tokens_stay_literal() {
    assert!(title_hit("zel", "Zelda").is_some());
    assert!(title_hit("zel", "zxl").is_none());
    assert!(title_hit("64", "Nintendo 64").is_some());
    assert!(title_hit("64", "Nintendo 65").is_none());
}

#[test]
fn literal_title_match_outranks_a_fuzzy_match() {
    let exact = title_hit("zelda", "Zelda II").expect("exact title hit");
    let fuzzy = title_hit("zelda", "Zelad II").expect("fuzzy title hit");
    assert!(exact > fuzzy);
}

#[test]
fn fewer_edits_outrank_a_shorter_and_earlier_title() {
    let one_edit =
        title_hit("adventure", "An Adventxure With A Very Long Name").expect("one edit title hit");
    let two_edits = title_hit("adventure", "Adventxxure").expect("two edit title hit");
    assert!(one_edit > two_edits);
}

#[test]
fn literal_substring_outranks_a_short_fuzzy_title() {
    let literal = title_hit(
        "zelda",
        "A Very Long Title With Several Words Before XZelda Appears",
    )
    .expect("literal substring title hit");
    let fuzzy = title_hit("zelda", "Zelad").expect("fuzzy title hit");
    assert!(literal > fuzzy);
}

#[test]
fn tokens_that_contain_numbers_stay_literal() {
    assert!(title_hit("zelda2", "Zelda2").is_some());
    assert!(title_hit("zelda2", "Zelda3").is_none());
}

#[test]
fn a_word_prefix_outranks_a_match_inside_a_word() {
    let prefix = hit("mario", &game("Mario Bros")).expect("word start hit");
    let inside = hit("mario", &game("Xmario Bros")).expect("substring hit");
    assert!(
        prefix > inside,
        "prefix {prefix} should beat inside {inside}"
    );
}

#[test]
fn a_longer_token_scores_above_a_shorter_one() {
    let long = hit("mario", &game("Mario Bros")).expect("hit");
    let short = hit("mar", &game("Mario Bros")).expect("hit");
    assert!(long > short);
}

#[test]
fn an_alternate_name_matches_but_ranks_below_the_primary_name() {
    let mut alternate = game("Puzzle Boy");
    alternate.alternate_names = vec!["Kwirk (USA)".to_string()];
    assert!(hit("kwirk", &alternate).is_some());

    let primary = game("Kwirk (USA)");
    assert!(
        hit("kwirk", &primary).expect("hit") > hit("kwirk", &alternate).expect("hit"),
        "a primary name hit outranks an alternate name hit"
    );
}

#[test]
fn a_good_dump_outranks_a_shorter_bad_dump() {
    let mut bad = game("Mario (U) [b1]");
    bad.dump_tags = vec!["b1".to_string()];
    let mut verified = game("Super Mario Bros (E) [!]");
    verified.dump_tags = vec!["!".to_string()];
    let untagged = game("Super Mario Bros 2 (USA)");
    let mut hack = game("Mario (U) [h1C]");
    hack.dump_tags = vec!["h1C".to_string()];
    let ordered = names("mario", &[bad, hack, untagged, verified]);
    assert_eq!(
        ordered,
        vec![
            "Super Mario Bros (E) [!]",
            "Super Mario Bros 2 (USA)",
            "Mario (U) [b1]",
            "Mario (U) [h1C]",
        ]
    );
}

#[test]
fn a_dump_tag_token_still_filters_to_tagged_dumps() {
    let mut bad = game("Mario (U) [b1]");
    bad.dump_tags = vec!["b1".to_string()];
    let mut verified = game("Mario (U) [!]");
    verified.dump_tags = vec!["!".to_string()];
    let untagged = game("Mario (USA)");
    assert_eq!(
        names(
            "mario bad",
            &[verified.clone(), untagged.clone(), bad.clone()]
        ),
        vec!["Mario (U) [b1]"]
    );
    assert_eq!(
        names(
            "mario b1",
            &[verified.clone(), untagged.clone(), bad.clone()]
        ),
        vec!["Mario (U) [b1]"]
    );
    assert_eq!(
        names("mario verified", &[verified, untagged, bad]),
        vec!["Mario (U) [!]"]
    );
}

#[test]
fn an_exact_bad_dump_outranks_a_fuzzy_good_dump() {
    let mut bad = game("Zelda (U) [b1]");
    bad.dump_tags = vec!["b1".to_string()];
    let mut typo = game("Zelad (U) [!]");
    typo.dump_tags = vec!["!".to_string()];
    let ordered = names("zelda", &[typo, bad]);
    assert_eq!(ordered, vec!["Zelda (U) [b1]", "Zelad (U) [!]"]);
}

#[test]
fn a_shorter_name_wins_a_tie() {
    let ordered = names(
        "mario",
        &[game("Mario Bros Deluxe Edition"), game("Mario Bros")],
    );
    assert_eq!(ordered, vec!["Mario Bros", "Mario Bros Deluxe Edition"]);
}

#[test]
fn dump_tags_match_the_raw_code_and_the_label() {
    let mut tagged = game("Zelda");
    tagged.dump_tags = vec!["!".to_string(), "a1".to_string()];
    // `!` never survives query normalization, so its label is its only path.
    assert!(hit("zelda verified", &tagged).is_some());
    assert!(hit("zelda good", &tagged).is_some());
    assert!(hit("zelda a1", &tagged).is_some());
    assert!(hit("zelda alternate", &tagged).is_some());
}

#[test]
fn dump_tag_labels_ignore_the_trailing_sequence_number_and_c() {
    let mut tagged = game("Zelda");
    tagged.dump_tags = vec!["h1C".to_string()];
    assert!(hit("zelda hack", &tagged).is_some());
    assert!(hit("zelda h1c", &tagged).is_some());
}

#[test]
fn a_translation_tag_and_a_trained_tag_keep_their_own_labels() {
    let mut translated = game("Zelda");
    translated.dump_tags = vec!["T".to_string()];
    let mut trained = game("Zelda");
    trained.dump_tags = vec!["t1".to_string()];
    assert!(hit("zelda translation", &translated).is_some());
    assert!(hit("zelda trained", &trained).is_some());
    // GoodTools reads `T` and `t` as different codes, so the labels MUST NOT
    // cross over. The query is lowercased before it reaches the tag, so a
    // label is the only way a reader can tell the two apart.
    assert!(hit("zelda trained", &translated).is_none());
    assert!(hit("zelda translation", &trained).is_none());
}

#[test]
fn decorated_dump_codes_still_reach_their_label() {
    // The shipped packs decorate a code with a language after `+`, a letter,
    // or a `_` sequence number: `T+Chi` is 759 records, `hI` is 835, `f_5` is
    // 870. Each MUST still answer to its code's label.
    for (tag, label) in [("T+Chi", "translation"), ("hI", "hack"), ("f_5", "fixed")] {
        let mut tagged = game("Zelda");
        tagged.dump_tags = vec![tag.to_string()];
        assert!(
            hit(&format!("zelda {label}"), &tagged).is_some(),
            "tag {tag} must match the label {label}"
        );
    }
}

#[test]
fn an_unknown_dump_code_has_no_label_but_keeps_its_raw_code() {
    // `C` and `d1` carry no label in the table, so they MUST NOT borrow one
    // from another code. The raw code stays searchable.
    let mut tagged = game("Zelda");
    tagged.dump_tags = vec!["C".to_string(), "d1".to_string()];
    assert!(hit("zelda c", &tagged).is_some());
    assert!(hit("zelda d1", &tagged).is_some());
    assert!(hit("zelda verified", &tagged).is_none());
}

#[test]
fn dump_tags_are_never_fuzzy_matched() {
    let mut tagged = game("Zelda");
    tagged.dump_tags = vec!["b1".to_string()];
    assert!(
        hit("zelda ba", &tagged).is_none(),
        "a prefix of a dump code must not match"
    );
    assert!(
        hit("zelda badly", &tagged).is_none(),
        "a label the code does not carry must not match"
    );
    assert!(hit("zelda bad", &tagged).is_some());
}

#[test]
fn results_come_back_best_first() {
    let mut alternate = game("Zzz Placeholder");
    alternate.alternate_names = vec!["Mario Bros".to_string()];
    let ordered = names(
        "mario",
        &[
            game("Xmario Adventure"),
            alternate,
            game("Mario Bros"),
            game("Nope"),
        ],
    );
    assert_eq!(
        ordered,
        vec!["Mario Bros", "Xmario Adventure", "Zzz Placeholder"]
    );
}

#[test]
fn ties_break_on_name_then_platform() {
    let mut first = game("Same Name");
    first.platform = "B".to_string();
    let mut second = game("Same Name");
    second.platform = "A".to_string();
    let parsed = NameQuery::new("same").expect("query");
    let games = vec![first, second];
    let hits = search_packs(&parsed, &[&games]);
    let platforms: Vec<&str> = hits
        .iter()
        .map(|hit| games[hit.game].platform.as_str())
        .collect();
    assert_eq!(platforms, vec!["A", "B"]);
}
