/**
 * Cross-platform title index: every pack's base game titles in one file, so a
 * name query can name the platforms that hold a title without loading a pack
 * and without the user choosing a platform first.
 *
 * The index stores base titles only - the display name with its first
 * parenthesised or bracketed tag group and everything after it removed. A row
 * per record would be 5.4 MB brotli against 1.6 MB for base titles, and the
 * regional variants of a chosen title come from the pack itself.
 *
 * Shared by the data builder (`scripts/build-identify-index.mjs`) and the
 * browser (`platform/browser/identify-packs.ts`). It MUST stay free of Node
 * and DOM APIs.
 */

const TITLE_INDEX_FORMAT = "rom-weaver-identify-title-index-v1";

/**
 * Latin letters with a diacritic, folded to their ASCII base, indexed from
 * U+00C0 and U+0100. An empty entry has no ASCII base and keeps its own
 * character. Ported from `crates/rom-weaver-cli/src/identify_name_search.rs`
 * (`FOLD_LATIN1`, `FOLD_LATIN_EXT_A`); the two MUST stay identical so a query
 * folds the same way in the browser and in the CLI.
 */
const FOLD_LATIN1 = [
  "a",
  "a",
  "a",
  "a",
  "a",
  "a",
  "ae",
  "c",
  "e",
  "e",
  "e",
  "e",
  "i",
  "i",
  "i",
  "i",
  "d",
  "n",
  "o",
  "o",
  "o",
  "o",
  "o",
  "",
  "o",
  "u",
  "u",
  "u",
  "u",
  "y",
  "th",
  "ss",
  "a",
  "a",
  "a",
  "a",
  "a",
  "a",
  "ae",
  "c",
  "e",
  "e",
  "e",
  "e",
  "i",
  "i",
  "i",
  "i",
  "d",
  "n",
  "o",
  "o",
  "o",
  "o",
  "o",
  "",
  "o",
  "u",
  "u",
  "u",
  "u",
  "y",
  "th",
  "y",
];
const FOLD_LATIN_EXT_A = [
  "a",
  "a",
  "a",
  "a",
  "a",
  "a",
  "c",
  "c",
  "c",
  "c",
  "c",
  "c",
  "c",
  "c",
  "d",
  "d",
  "d",
  "d",
  "e",
  "e",
  "e",
  "e",
  "e",
  "e",
  "e",
  "e",
  "e",
  "e",
  "g",
  "g",
  "g",
  "g",
  "g",
  "g",
  "g",
  "g",
  "h",
  "h",
  "h",
  "h",
  "i",
  "i",
  "i",
  "i",
  "i",
  "i",
  "i",
  "i",
  "i",
  "i",
  "",
  "",
  "j",
  "j",
  "k",
  "k",
  "k",
  "l",
  "l",
  "l",
  "l",
  "l",
  "l",
  "",
  "",
  "l",
  "l",
  "n",
  "n",
  "n",
  "n",
  "n",
  "n",
  "n",
  "n",
  "n",
  "o",
  "o",
  "o",
  "o",
  "o",
  "o",
  "oe",
  "oe",
  "r",
  "r",
  "r",
  "r",
  "r",
  "r",
  "s",
  "s",
  "s",
  "s",
  "s",
  "s",
  "s",
  "s",
  "t",
  "t",
  "t",
  "t",
  "",
  "",
  "u",
  "u",
  "u",
  "u",
  "u",
  "u",
  "u",
  "u",
  "u",
  "u",
  "u",
  "u",
  "w",
  "w",
  "y",
  "y",
  "y",
  "z",
  "z",
  "z",
  "z",
  "z",
  "z",
  "",
];

const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;

/**
 * Code-unit string order, not locale order, so the builder and the browser
 * agree on the file's byte-identical layout.
 * @param {string} left
 * @param {string} right
 */
const compareStrings = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/**
 * The ASCII spelling of one accented Latin letter, or `undefined` when the
 * character has none. Scripts with no ASCII base keep their own characters.
 * @param {number} code
 */
const foldDiacritic = (code) => {
  let folded;
  if (code >= 0x00c0 && code <= 0x00ff) folded = FOLD_LATIN1[code - 0x00c0];
  else if (code >= 0x0100 && code <= 0x017f) folded = FOLD_LATIN_EXT_A[code - 0x0100];
  else if (code === 0x01a0 || code === 0x01a1) folded = "o";
  else if (code === 0x01af || code === 0x01b0) folded = "u";
  return folded ? folded : undefined;
};

/**
 * Lowercase `text`, fold its accented Latin letters to ASCII, and collapse
 * every run of non-alphanumeric characters into one space. Ported from
 * `normalize_into` in `crates/rom-weaver-cli/src/identify_name_search.rs`.
 * @param {string} text
 * @returns {string}
 */
const normalizeTitle = (text) => {
  let out = "";
  let pendingSpace = false;
  for (const character of String(text ?? "")) {
    if (ALPHANUMERIC.test(character)) {
      if (pendingSpace && out.length) out += " ";
      pendingSpace = false;
      const folded = foldDiacritic(character.codePointAt(0) ?? 0);
      out += folded ?? character.toLowerCase();
    } else {
      pendingSpace = true;
    }
  }
  return out;
};

/**
 * The display title with the first ` (` or ` [` tag group and everything after
 * it removed. A name that opens with a tag keeps its whole name: an empty
 * title would be unsearchable. Trailing English articles MUST move before
 * the title so catalog spellings group together across packs.
 * @param {string} name
 * @returns {string}
 */
const baseTitle = (name) => {
  const text = String(name ?? "");
  const cuts = [text.indexOf(" ("), text.indexOf(" [")].filter((index) => index !== -1);
  const base = (cuts.length ? text.slice(0, Math.min(...cuts)) : text).trim();
  return (base || text.trim()).replace(
    /^(.+?),\s+(the|an|a)(?=\s*(?:$|[-:–—]))/iu,
    (_, title, article) => `${article[0].toUpperCase()}${article.slice(1).toLowerCase()} ${title}`,
  );
};

/**
 * @typedef {{ name: string; slugs: string[] }} TitleEntry
 * @typedef {{ name: string; normalized: string; packs: number[] }} TitleRow
 * @typedef {{ packs: string[]; titles: TitleRow[] }} TitleIndex
 */

/**
 * Merge entries by normalized title and serialize them. Titles are ordered by
 * normalized key then display name and pack indexes ascending, so a rebuild
 * over the same input is byte-identical.
 * @param {Iterable<TitleEntry>} entries
 * @returns {string}
 */
const encodeTitleIndex = (entries) => {
  /** @type {Map<string, { name: string; slugs: Set<string> }>} */
  const byNormalized = new Map();
  const packSlugs = new Set();
  for (const entry of entries) {
    const name = baseTitle(entry?.name ?? "");
    if (!name) continue;
    const normalized = normalizeTitle(name);
    if (!normalized) continue;
    let row = byNormalized.get(normalized);
    if (!row) {
      row = { name, slugs: new Set() };
      byNormalized.set(normalized, row);
    } else if (name < row.name) {
      // Several display spellings fold to one key; the first by plain string
      // sort is the stored one, so the choice does not depend on input order.
      row.name = name;
    }
    for (const slug of entry.slugs || []) {
      if (!slug) throw new Error("title index: a title entry has an empty pack slug");
      row.slugs.add(slug);
      packSlugs.add(slug);
    }
  }
  const packs = [...packSlugs].sort(compareStrings);
  const packIndex = new Map(packs.map((slug, index) => [slug, index]));
  const titles = [...byNormalized.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        compareStrings(leftKey, rightKey) || compareStrings(left.name, right.name),
    )
    .map(([, row]) => [row.name, [...row.slugs].map((slug) => packIndex.get(slug) ?? 0).sort((a, b) => a - b)]);
  return JSON.stringify({ format: TITLE_INDEX_FORMAT, packs, titles });
};

/** @param {string} message */
const invalid = (message) => new Error(`title index is invalid: ${message}`);

/**
 * Parse and validate a title index. Every shape and bound is checked so a
 * corrupt file fails here instead of producing wrong platform names.
 * @param {string} text
 * @returns {TitleIndex}
 */
const parseTitleIndex = (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw invalid(`not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid("not an object");
  if (data.format !== TITLE_INDEX_FORMAT) throw invalid(`unexpected format ${String(data.format)}`);
  if (!Array.isArray(data.packs)) throw invalid("packs is not an array");
  /** @type {string[]} */
  const packs = [];
  for (const slug of data.packs) {
    if (typeof slug !== "string" || !slug) throw invalid("a pack slug is empty or not a string");
    packs.push(slug);
  }
  if (!Array.isArray(data.titles)) throw invalid("titles is not an array");
  /** @type {TitleRow[]} */
  const titles = [];
  for (const row of data.titles) {
    if (!Array.isArray(row) || row.length !== 2) throw invalid("a title row is not a [name, packs] pair");
    const [name, indexes] = row;
    if (typeof name !== "string" || !name) throw invalid("a title name is empty or not a string");
    if (!(Array.isArray(indexes) && indexes.length)) throw invalid(`${name}: no pack indexes`);
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= packs.length) {
        throw invalid(`${name}: pack index ${String(index)} is out of range`);
      }
    }
    titles.push({ name, normalized: normalizeTitle(name), packs: [...indexes] });
  }
  return { packs, titles };
};

export { baseTitle, encodeTitleIndex, normalizeTitle, parseTitleIndex, TITLE_INDEX_FORMAT };
