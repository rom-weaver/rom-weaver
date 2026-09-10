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
const EXACT_WORD_BONUS: i64 = 100;
const WORD_PREFIX_BONUS: i64 = 70;
const TOKEN_BASE: i64 = 10;
const RUN_WEIGHT: i64 = 2;
const RUN_LENGTH_CAP: usize = 32;
const NAME_LENGTH_PENALTY_CAP: i64 = 255;
const MAX_TOKEN_QUALITY: i64 = TOKEN_BASE
    + RUN_WEIGHT * RUN_LENGTH_CAP as i64
    + EXACT_WORD_BONUS
    + WORD_START_BONUS
    + NAME_WEIGHT;

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

/// A normalized query token and its Unicode scalar values. Storing the
/// scalars avoids repeatedly walking a token while comparing title words.
#[derive(Debug)]
struct QueryToken {
    text: String,
    characters: Vec<char>,
    typo_limit: Option<usize>,
}

impl QueryToken {
    fn new(text: String) -> Self {
        let characters: Vec<char> = text.chars().collect();
        let length = characters.len();
        let typo_limit = if characters.iter().any(|character| character.is_numeric()) || length < 4
        {
            None
        } else if length <= 6 {
            Some(1)
        } else {
            Some(2)
        };
        Self {
            text,
            characters,
            typo_limit,
        }
    }
}

/// One matched query token. Ordering this type puts literal matches first,
/// then lower edit distances, then field and position quality.
#[derive(Clone, Copy, Debug)]
struct TokenScore {
    literal: bool,
    distance: usize,
    quality: i64,
}

impl TokenScore {
    fn better_than(self, other: Self) -> bool {
        (self.literal && !other.literal)
            || (self.literal == other.literal
                && (self.distance < other.distance
                    || (self.distance == other.distance && self.quality > other.quality)))
    }
}

/// Score a literal token occurrence. Full-word matches beat prefixes, which
/// beat matches inside a word; earlier words break otherwise equal matches.
fn literal_token_score(token: &QueryToken, candidate: &str) -> Option<TokenScore> {
    let base = TOKEN_BASE + RUN_WEIGHT * token.characters.len().min(RUN_LENGTH_CAP) as i64;
    let mut best = None;
    for (word_index, word) in candidate.split(' ').enumerate() {
        let mut search_from = 0;
        while let Some(offset) = word[search_from..].find(&token.text) {
            let offset = search_from + offset;
            let mut quality = base - word_index.min(20) as i64;
            if offset == 0 {
                quality += WORD_START_BONUS;
                if word == token.text {
                    quality += EXACT_WORD_BONUS;
                } else {
                    quality += WORD_PREFIX_BONUS;
                }
            }
            let score = TokenScore {
                literal: true,
                distance: 0,
                quality,
            };
            best = Some(best.map_or(score, |current| {
                if score.better_than(current) {
                    score
                } else {
                    current
                }
            }));
            search_from = offset + token.text.len();
        }
    }
    best
}

/// The bounded optimal-string-alignment distance. OSA is the restricted
/// Damerau-Levenshtein metric: it counts one adjacent transposition, while
/// forbidding a character from taking part in more than one edit. The search
/// only needs distances at or below `limit`, so it evaluates a narrow band.
fn osa_distance_at_most(
    token: &QueryToken,
    word: &str,
    limit: usize,
    scratch: &mut SearchScratch,
) -> Option<usize> {
    scratch.characters.clear();
    scratch.characters.extend(word.chars());
    let width = scratch.characters.len();
    let height = token.characters.len();
    if height.abs_diff(width) > limit {
        return None;
    }

    scratch.osa_before_previous.clear();
    scratch.osa_before_previous.extend(0..=width);
    scratch
        .osa_previous
        .clone_from(&scratch.osa_before_previous);
    scratch.osa_current.resize(width + 1, limit + 1);
    for row in 1..=height {
        scratch.osa_current.fill(limit + 1);
        scratch.osa_current[0] = row;
        let start = row.saturating_sub(limit).max(1);
        let end = (row + limit).min(width);
        let mut row_best = limit + 1;
        for column in start..=end {
            let substitution = scratch.osa_previous[column - 1]
                + usize::from(token.characters[row - 1] != scratch.characters[column - 1]);
            let deletion = scratch.osa_previous[column] + 1;
            let insertion = scratch.osa_current[column - 1] + 1;
            let mut value = substitution.min(deletion).min(insertion);
            if row > 1
                && column > 1
                && token.characters[row - 1] == scratch.characters[column - 2]
                && token.characters[row - 2] == scratch.characters[column - 1]
            {
                value = value.min(scratch.osa_before_previous[column - 2] + 1);
            }
            scratch.osa_current[column] = value;
            row_best = row_best.min(value);
        }
        if row_best > limit {
            return None;
        }
        std::mem::swap(&mut scratch.osa_before_previous, &mut scratch.osa_previous);
        std::mem::swap(&mut scratch.osa_previous, &mut scratch.osa_current);
    }
    (scratch.osa_previous[width] <= limit).then_some(scratch.osa_previous[width])
}

/// Score one token against normalized candidate text. A literal token always
/// scores above a fuzzy token. Fuzzy work is bounded by the typo limit and is
/// done only for title words whose lengths can possibly be within that limit.
fn token_score(
    token: &QueryToken,
    candidate: &str,
    scratch: &mut SearchScratch,
) -> Option<TokenScore> {
    if let Some(score) = literal_token_score(token, candidate) {
        return Some(score);
    }
    let limit = token.typo_limit?;
    let base = TOKEN_BASE + RUN_WEIGHT * token.characters.len().min(RUN_LENGTH_CAP) as i64;
    let mut best = None;
    for (word_index, word) in candidate.split(' ').enumerate() {
        let Some(distance) = osa_distance_at_most(token, word, limit, scratch) else {
            continue;
        };
        let score = TokenScore {
            literal: false,
            distance,
            quality: base - word_index.min(20) as i64,
        };
        best = Some(best.map_or(score, |current| {
            if score.better_than(current) {
                score
            } else {
                current
            }
        }));
    }
    best
}

/// A parsed name query. Empty queries are rejected by `new`, so every search
/// runs with at least one token.
#[derive(Debug)]
pub(super) struct NameQuery {
    normalized: String,
    tokens: Vec<QueryToken>,
}

/// Scratch buffers a search reuses for every candidate.
#[derive(Default)]
pub(super) struct SearchScratch {
    text: String,
    best: Vec<Option<TokenScore>>,
    characters: Vec<char>,
    osa_before_previous: Vec<usize>,
    osa_previous: Vec<usize>,
    osa_current: Vec<usize>,
}

/// The strongest score each query token receives from one platform's
/// canonical name and aliases. This is computed once per platform, then
/// merged into each title that platform owns.
pub(super) struct SystemMatch {
    scores: Vec<Option<TokenScore>>,
}

impl NameQuery {
    pub(super) fn new(query: &str) -> Result<Self> {
        let normalized = normalize(query);
        let tokens: Vec<QueryToken> = normalized
            .split(' ')
            .filter(|token| !token.is_empty())
            .map(str::to_string)
            .map(QueryToken::new)
            .collect();
        if tokens.is_empty() {
            return Err(RomWeaverError::Validation(
                "--name needs at least one letter or digit to search for".to_string(),
            ));
        }
        trace!(tokens = ?tokens, "parsed identify name query");
        Ok(Self { normalized, tokens })
    }

    /// Raise this token's best score when `candidate` has a stronger match.
    fn offer(best: &mut Option<TokenScore>, score: TokenScore) {
        *best = Some(best.map_or(score, |current| {
            if score.better_than(current) {
                score
            } else {
                current
            }
        }));
    }

    fn offer_title_scores(&self, candidate: &str, weight: i64, scratch: &mut SearchScratch) {
        for (index, token) in self.tokens.iter().enumerate() {
            if let Some(score) = token_score(token, candidate, scratch) {
                Self::offer(
                    &mut scratch.best[index],
                    TokenScore {
                        quality: score.quality.saturating_add(weight),
                        ..score
                    },
                );
            }
        }
    }

    /// Encode the lexicographic token ordering into a sortable score. The
    /// dynamic distance weight exceeds every title-quality contribution, so
    /// total edit distance always beats field, position, and title length.
    fn finish_score(&self, name_length: i64, scratch: &SearchScratch) -> Option<i64> {
        let mut total_distance = 0_i64;
        let mut quality = -name_length.min(NAME_LENGTH_PENALTY_CAP);
        let mut all_literal = true;
        for score in &scratch.best {
            let score = (*score)?;
            total_distance = total_distance.saturating_add(score.distance as i64);
            quality = quality.saturating_add(score.quality);
            all_literal &= score.literal;
        }
        let token_count = i64::try_from(self.tokens.len()).unwrap_or(i64::MAX);
        let secondary_range = (MAX_TOKEN_QUALITY + 2)
            .saturating_mul(token_count)
            .saturating_add(NAME_LENGTH_PENALTY_CAP);
        let distance_weight = secondary_range.saturating_add(1);
        let literal_bonus =
            distance_weight.saturating_mul(token_count.saturating_mul(2).saturating_add(1));
        Some(
            quality
                .saturating_sub(total_distance.saturating_mul(distance_weight))
                .saturating_add(if all_literal { literal_bonus } else { 0 }),
        )
    }

    /// The game's score, or `None` when any query token matches none of the
    /// game's name, alternate names or dump tags. Every token MUST match.
    /// Each candidate string is normalized once, so the cost per game stays
    /// proportional to its own text and not to the query length.
    pub(super) fn score(&self, game: &PackGame, scratch: &mut SearchScratch) -> Option<i64> {
        scratch.best.clear();
        scratch.best.resize(self.tokens.len(), None);
        normalize_into(&game.name, &mut scratch.text);
        let name_length = i64::try_from(scratch.text.chars().count()).unwrap_or(i64::MAX);
        let text = std::mem::take(&mut scratch.text);
        self.offer_title_scores(&text, NAME_WEIGHT, scratch);
        scratch.text = text;
        for alternate in &game.alternate_names {
            normalize_into(alternate, &mut scratch.text);
            let text = std::mem::take(&mut scratch.text);
            self.offer_title_scores(&text, ALTERNATE_WEIGHT, scratch);
            scratch.text = text;
        }
        for tag in &game.dump_tags {
            for (index, token) in self.tokens.iter().enumerate() {
                if dump_tag_matches(&token.text, tag) {
                    Self::offer(
                        &mut scratch.best[index],
                        TokenScore {
                            literal: true,
                            distance: 0,
                            quality: TOKEN_BASE + TAG_WEIGHT,
                        },
                    );
                }
            }
        }
        self.finish_score(name_length, scratch)
    }

    /// Score one title with the same normalization and token rules as pack
    /// names. This supports title indexes without creating a synthetic pack.
    pub(super) fn score_title(&self, name: &str, scratch: &mut SearchScratch) -> Option<i64> {
        scratch.best.clear();
        scratch.best.resize(self.tokens.len(), None);
        normalize_into(name, &mut scratch.text);
        let name_length = i64::try_from(scratch.text.chars().count()).unwrap_or(i64::MAX);
        let text = std::mem::take(&mut scratch.text);
        let prefix_weight = if text.starts_with(&self.normalized) {
            NAME_WEIGHT
        } else {
            0
        };
        self.offer_title_scores(&text, prefix_weight, scratch);
        scratch.text = text;
        self.finish_score(name_length, scratch)
    }

    /// Score one platform's canonical name and aliases for reuse across its
    /// titles.
    pub(super) fn score_systems<'a>(
        &self,
        systems: impl IntoIterator<Item = &'a str>,
        scratch: &mut SearchScratch,
    ) -> SystemMatch {
        scratch.best.clear();
        scratch.best.resize(self.tokens.len(), None);
        for system in systems {
            normalize_into(system, &mut scratch.text);
            let text = std::mem::take(&mut scratch.text);
            self.offer_title_scores(&text, 0, scratch);
            scratch.text = text;
        }
        SystemMatch {
            scores: scratch.best.clone(),
        }
    }

    /// The quality that selects one platform from a shared title row. Literal
    /// platform tokens outrank corrections so `snes` does not also select
    /// `nes` through one insertion.
    pub(super) fn system_match_rank(&self, systems: &SystemMatch) -> Option<(usize, i64, i64)> {
        let mut literal = 0;
        let mut distance = 0_i64;
        let mut quality = 0_i64;
        let mut matched = false;
        for score in systems.scores.iter().flatten() {
            matched = true;
            literal += usize::from(score.literal);
            distance = distance.saturating_add(score.distance as i64);
            quality = quality.saturating_add(score.quality);
        }
        matched.then_some((literal, -distance, quality))
    }

    /// Score a title with a platform match. Platform terms only fill query
    /// tokens the title does not match, so title matches keep their score and
    /// ordering when a system term is added.
    pub(super) fn score_title_with_system_match(
        &self,
        name: &str,
        systems: &SystemMatch,
        scratch: &mut SearchScratch,
    ) -> Option<(i64, bool)> {
        if let Some(score) = self.score_title(name, scratch) {
            return Some((score, true));
        }
        let name_length = i64::try_from(scratch.text.chars().count()).unwrap_or(i64::MAX);
        for (best, system_score) in scratch.best.iter_mut().zip(&systems.scores) {
            if best.is_none() {
                *best = *system_score;
            }
        }
        self.finish_score(name_length, scratch)
            .map(|score| (score, false))
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
