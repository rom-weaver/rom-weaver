//! The fuzzy name search over identify packs: query normalization, the
//! GoodTools dump-tag labels, and the per-game score that orders the results.

use rom_weaver_checksum::identify_pack_types::PackGame;

use super::*;

/// Score weights. A hit on the primary name outranks one on an alternate
/// name, which outranks one on a dump tag, so a token that matches several
/// fields keeps the strongest field's weight.
const NAME_WEIGHT: i64 = 300;
const ALTERNATE_WEIGHT: i64 = 150;
const TAG_WEIGHT: i64 = 50;
const WORD_START_BONUS: i64 = 40;
const TOKEN_BASE: i64 = 10;
const RUN_WEIGHT: i64 = 2;

/// Human labels for the raw GoodTools dump codes a pack stores. A dump tag is
/// one or two characters, so it MUST match on equality only, never fuzzily.
/// Query normalization drops punctuation, so a code that is punctuation (`!`)
/// is reachable through its label alone; every label here MUST therefore stay
/// searchable.
const DUMP_TAG_LABELS: &[(&str, &[&str])] = &[
    ("!", &["verified", "good"]),
    ("a", &["alternate"]),
    ("b", &["bad", "dump"]),
    ("o", &["overdump"]),
    ("f", &["fixed"]),
    ("t", &["trained"]),
    ("h", &["hack"]),
    ("p", &["pirate"]),
    ("T", &["translation"]),
    ("n", &["no", "intro", "variant"]),
];

/// Latin letters with a diacritic, folded to their ASCII base, indexed from
/// U+00C0 and U+0100. An empty entry has no ASCII base and keeps its own
/// character.
const FOLD_LATIN1: [&str; 64] = [
    "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i", "d", "n", "o",
    "o", "o", "o", "o", "", "o", "u", "u", "u", "u", "y", "th", "ss", "a", "a", "a", "a", "a", "a",
    "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i", "d", "n", "o", "o", "o", "o", "o", "", "o",
    "u", "u", "u", "u", "y", "th", "y",
];
const FOLD_LATIN_EXT_A: [&str; 128] = [
    "a", "a", "a", "a", "a", "a", "c", "c", "c", "c", "c", "c", "c", "c", "d", "d", "d", "d", "e",
    "e", "e", "e", "e", "e", "e", "e", "e", "e", "g", "g", "g", "g", "g", "g", "g", "g", "h", "h",
    "h", "h", "i", "i", "i", "i", "i", "i", "i", "i", "i", "i", "", "", "j", "j", "k", "k", "k",
    "l", "l", "l", "l", "l", "l", "", "", "l", "l", "n", "n", "n", "n", "n", "n", "n", "n", "n",
    "o", "o", "o", "o", "o", "o", "oe", "oe", "r", "r", "r", "r", "r", "r", "s", "s", "s", "s",
    "s", "s", "s", "s", "t", "t", "t", "t", "", "", "u", "u", "u", "u", "u", "u", "u", "u", "u",
    "u", "u", "u", "w", "w", "y", "y", "y", "z", "z", "z", "z", "z", "z", "",
];

/// The ASCII spelling of one accented Latin letter, or `None` when the
/// character has none.
///
/// The shipped packs hold accented titles (`Astérix`), and a reader searches
/// for them with an unaccented keyboard, so both sides of the comparison MUST
/// be folded. Scripts with no ASCII base, such as CJK and Cyrillic, keep their
/// own characters and still match a query typed in the same script.
fn fold_diacritic(character: char) -> Option<&'static str> {
    let folded = match character as u32 {
        code @ 0x00C0..=0x00FF => FOLD_LATIN1[(code - 0x00C0) as usize],
        code @ 0x0100..=0x017F => FOLD_LATIN_EXT_A[(code - 0x0100) as usize],
        0x01A0 | 0x01A1 => "o",
        0x01AF | 0x01B0 => "u",
        _ => return None,
    };
    (!folded.is_empty()).then_some(folded)
}

/// Lowercase `text`, fold its accented Latin letters to ASCII, and collapse
/// every run of non-alphanumeric characters into one space, writing the result
/// into `out`. The buffer is reused across candidates: a search over a 200k-game
/// pack MUST not allocate per candidate.
fn normalize_into(text: &str, out: &mut String) {
    out.clear();
    let mut pending_space = false;
    for character in text.chars() {
        if character.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            if let Some(folded) = fold_diacritic(character) {
                out.push_str(folded);
                continue;
            }
            for lowered in character.to_lowercase() {
                out.push(lowered);
            }
        } else {
            pending_space = true;
        }
    }
}

fn normalize(text: &str) -> String {
    let mut out = String::new();
    normalize_into(text, &mut out);
    out
}

/// The label-table code a dump tag belongs to, or `None` for a code the table
/// does not name.
///
/// A tag decorates its code with a sequence number, a `C` suffix, a letter
/// suffix, or a language after `+`, `-` or `_` (`a1`, `h1C`, `hI`, `T+Chi`,
/// `f_5`), so the code is the longest table entry the tag starts with. The
/// comparison MUST stay case-sensitive: GoodTools reads `t` as trained and `T`
/// as translation, and a case-insensitive lookup gives a tag both labels.
fn dump_tag_code(tag: &str) -> Option<&'static str> {
    let base = tag
        .split(['+', '-', '_'])
        .next()
        .filter(|base| !base.is_empty())
        .unwrap_or(tag);
    DUMP_TAG_LABELS
        .iter()
        .map(|(code, _)| *code)
        .filter(|code| base.starts_with(code))
        .max_by_key(|code| code.len())
}

/// Whether `token` names this dump tag: the raw code itself, case-insensitive,
/// or one word of the code's human label.
fn dump_tag_matches(token: &str, tag: &str) -> bool {
    if tag.eq_ignore_ascii_case(token) {
        return true;
    }
    let Some(code) = dump_tag_code(tag) else {
        return false;
    };
    DUMP_TAG_LABELS
        .iter()
        .filter(|(entry, _)| *entry == code)
        .any(|(_, labels)| labels.contains(&token))
}

/// The score of one token against one normalized candidate text, or `None`
/// when the token appears nowhere in it. A prefix of a word beats a match in
/// the middle of one, and a longer token beats a shorter one.
fn token_score(token: &str, candidate: &str) -> Option<i64> {
    let position = candidate.find(token)?;
    let at_word_start = position == 0 || candidate.as_bytes()[position - 1] == b' ';
    let mut score = TOKEN_BASE + RUN_WEIGHT * token.chars().count() as i64;
    if at_word_start {
        score += WORD_START_BONUS;
    }
    Some(score)
}

/// A parsed name query. Empty queries are rejected by `new`, so every search
/// runs with at least one token.
#[derive(Debug)]
pub(super) struct NameQuery {
    tokens: Vec<String>,
}

/// Scratch buffers a search reuses for every candidate.
#[derive(Default)]
pub(super) struct SearchScratch {
    text: String,
    best: Vec<Option<i64>>,
}

impl NameQuery {
    pub(super) fn new(query: &str) -> Result<Self> {
        let normalized = normalize(query);
        let tokens: Vec<String> = normalized
            .split(' ')
            .filter(|token| !token.is_empty())
            .map(str::to_string)
            .collect();
        if tokens.is_empty() {
            return Err(RomWeaverError::Validation(
                "--name needs at least one letter or digit to search for".to_string(),
            ));
        }
        trace!(tokens = ?tokens, "parsed identify name query");
        Ok(Self { tokens })
    }

    /// Raise this token's best score when `candidate` beats what it has.
    fn offer(best: &mut Option<i64>, score: i64) {
        *best = Some(best.map_or(score, |current: i64| current.max(score)));
    }

    /// The game's score, or `None` when any query token matches none of the
    /// game's name, alternate names or dump tags. Every token MUST match.
    /// Each candidate string is normalized once, so the cost per game stays
    /// proportional to its own text and not to the query length.
    pub(super) fn score(&self, game: &PackGame, scratch: &mut SearchScratch) -> Option<i64> {
        scratch.best.clear();
        scratch.best.resize(self.tokens.len(), None);
        normalize_into(&game.name, &mut scratch.text);
        let name_length = scratch.text.chars().count() as i64;
        for (index, token) in self.tokens.iter().enumerate() {
            if let Some(score) = token_score(token, &scratch.text) {
                Self::offer(&mut scratch.best[index], score + NAME_WEIGHT);
            }
        }
        for alternate in &game.alternate_names {
            normalize_into(alternate, &mut scratch.text);
            for (index, token) in self.tokens.iter().enumerate() {
                if let Some(score) = token_score(token, &scratch.text) {
                    Self::offer(&mut scratch.best[index], score + ALTERNATE_WEIGHT);
                }
            }
        }
        for tag in &game.dump_tags {
            for (index, token) in self.tokens.iter().enumerate() {
                if dump_tag_matches(token, tag) {
                    Self::offer(&mut scratch.best[index], TOKEN_BASE + TAG_WEIGHT);
                }
            }
        }
        let mut total = 0;
        for best in &scratch.best {
            total += (*best)?;
        }
        // A shorter name is the closer answer for the same tokens.
        Some(total - name_length)
    }
}

/// One scored hit: the score plus where the game lives, so the caller can read
/// the record back without cloning it during the scan.
pub(super) struct ScoredGame {
    pub(super) score: i64,
    pub(super) pack: usize,
    pub(super) game: usize,
}

/// Score every game of every pack and return the hits, best first. `packs`
/// supplies each pack's games in the order the caller holds them.
pub(super) fn search_packs(query: &NameQuery, packs: &[&[PackGame]]) -> Vec<ScoredGame> {
    let mut scratch = SearchScratch::default();
    let mut hits: Vec<ScoredGame> = Vec::new();
    for (pack_index, games) in packs.iter().enumerate() {
        for (game_index, game) in games.iter().enumerate() {
            if let Some(score) = query.score(game, &mut scratch) {
                hits.push(ScoredGame {
                    score,
                    pack: pack_index,
                    game: game_index,
                });
            }
        }
    }
    // Ties MUST break on name then platform so repeated runs print the same
    // order.
    hits.sort_by(|left, right| {
        let left_game = &packs[left.pack][left.game];
        let right_game = &packs[right.pack][right.game];
        right
            .score
            .cmp(&left.score)
            .then_with(|| left_game.name.cmp(&right_game.name))
            .then_with(|| left_game.platform.cmp(&right_game.platform))
    });
    trace!(hits = hits.len(), "identify name search finished");
    hits
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "../tests/unit/identify_name_search.rs"]
mod tests;
