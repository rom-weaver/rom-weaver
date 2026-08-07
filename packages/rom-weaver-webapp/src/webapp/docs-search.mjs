/**
 * @typedef {{ id: string | null, label: string, text: string }} SearchEntry
 * @typedef {{ description: string, html: string, label: string, sections: readonly { id: string, label: string }[], slug: string, title: string }} SearchSourceRoute
 * @typedef {{ description: string, label: string, searchEntries: readonly SearchEntry[], sections: readonly { id: string, label: string }[], slug: string, title: string }} SearchRoute
 * @typedef {{ entry: SearchEntry, route: SearchRoute, routeIndex: number, entryIndex: number, score: number, snippet: string }} SearchMatch
 * @typedef {{ index: number, score: number, text: string }} SearchTokenMatch
 */

/** @param {string} value */
const normalizeSearchText = (value) =>
  String(value)
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase();

/** @param {string} value */
const searchTokens = (value) => normalizeSearchText(value).match(/[\p{Letter}\p{Number}]+/gu) ?? [];

/** @param {string} left @param {string} right @param {number} maximum */
const editDistance = (left, right, maximum) => {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let minimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left.charAt(row - 1) === right.charAt(column - 1) ? 0 : 1;
      const value = Math.min(
        (current[column - 1] ?? maximum + 1) + 1,
        (previous[column] ?? maximum + 1) + 1,
        (previous[column - 1] ?? maximum + 1) + cost,
      );
      current.push(value);
      minimum = Math.min(minimum, value);
    }
    if (minimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length] ?? maximum + 1;
};

/** @param {string} query @param {string} candidate */
const tokenMatchScore = (query, candidate) => {
  if (query === candidate) return 1;
  if (candidate.startsWith(query)) return 0.86;
  if (candidate.includes(query)) return 0.72;
  if (query.length < 3) return 0;
  return editDistance(query, candidate, 1) === 1 ? 0.58 : 0;
};

/** @param {string} text @param {string} query @returns {SearchTokenMatch | null} */
const findSearchToken = (text, query) => {
  const queryTokens = searchTokens(query);
  if (!queryTokens.length) return null;
  let best = null;
  for (const match of String(text).matchAll(/[\p{Letter}\p{Number}]+/gu)) {
    const candidate = normalizeSearchText(match[0]);
    const score = Math.max(...queryTokens.map((queryToken) => tokenMatchScore(queryToken, candidate)));
    if (!best || score > best.score) best = { index: match.index ?? 0, score, text: match[0] };
  }
  return best && best.score > 0 ? best : null;
};

/** @param {string[]} query @param {Array<{ tokens: string[], weight: number }>} fields */
const scoreEntry = (query, fields) => {
  let score = 0;
  for (const queryToken of query) {
    let best = 0;
    for (const field of fields) {
      for (const candidate of field.tokens) {
        best = Math.max(best, tokenMatchScore(queryToken, candidate) * field.weight);
      }
    }
    if (best === 0) return 0;
    score += best;
  }
  return score / query.length;
};

/** @param {string} text @param {string} query */
const createSnippet = (text, query) => {
  const clean = String(text).replace(/\s+/g, " ").trim();
  const firstToken = searchTokens(query)[0];
  const startAt = firstToken ? normalizeSearchText(clean).indexOf(firstToken) : -1;
  const start = startAt > 64 ? startAt - 64 : 0;
  const end = Math.min(clean.length, start + 140);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
};

/** Entities marked emits in rendered guide HTML; anything unrecognized decays to a space. */
const TEXT_ENTITIES = /** @type {Record<string, string>} */ ({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

/** @param {string} value */
const decodeTextEntities = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, reference) => {
    const name = String(reference).toLowerCase();
    const named = TEXT_ENTITIES[name];
    if (named !== undefined) return named;
    if (!name.startsWith("#")) return " ";
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
  });

/** @param {string} html */
const htmlToText = (html) =>
  decodeTextEntities(String(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

// String-based rather than DOM-based so the index can be prebuilt at build
// time (scripts/docs-virtual-module.mjs) and the guides' HTML never has to
// ship a second time just to be searchable. Guide sections are the top-level
// `<h2>` blocks whose IDs appear in `sections`; pages can also contain other
// h2 blocks, such as the FAQ's question-level contents.
/** @param {SearchSourceRoute} route @returns {SearchRoute} */
const indexRoute = ({ description, html, label, sections, slug, title }) => {
  const parts = String(html).split(/(?=<h2[\s>])/);
  const sectionParts = new Map(
    parts.slice(1).flatMap((part) => {
      const id = part.match(/^<h2\b[^>]*\bid="([^"]+)"/)?.[1];
      return id ? [[id, part]] : [];
    }),
  );
  const intro = parts[0] ?? "";
  /** @type {SearchEntry[]} */
  const entries = [
    {
      id: null,
      label: title,
      text: `${title} ${description} ${htmlToText(intro)}`.trim(),
    },
  ];
  for (const section of sections) {
    const part = sectionParts.get(section.id);
    if (part === undefined) continue;
    entries.push({
      id: section.id,
      label: section.label,
      text: htmlToText(part),
    });
  }
  return { description, label, searchEntries: entries, sections, slug, title };
};

/** @param {readonly SearchSourceRoute[]} routes */
const createDocsSearchIndex = (routes) => routes.map(indexRoute);

/**
 * @param {readonly SearchRoute[]} routes
 * @param {string} query
 * @param {number} [limit]
 */
const searchDocs = (routes, query, limit = 8) => {
  const queryTokens = searchTokens(query);
  if (!queryTokens.length) return [];

  /** @type {SearchMatch[]} */
  const matches = [];
  routes.forEach((route, routeIndex) => {
    route.searchEntries.forEach((entry, entryIndex) => {
      const fields =
        entry.id === null
          ? [
              { tokens: searchTokens(route.title), weight: 4 },
              { tokens: searchTokens(route.label), weight: 3 },
              { tokens: searchTokens(entry.label), weight: 4 },
              { tokens: searchTokens(route.description), weight: 2 },
              { tokens: searchTokens(entry.text), weight: 1 },
            ]
          : [
              { tokens: searchTokens(entry.label), weight: 4 },
              { tokens: searchTokens(entry.text), weight: 1 },
            ];
      const score = scoreEntry(queryTokens, fields);
      if (score > 0)
        matches.push({ entry, route, routeIndex, entryIndex, score, snippet: createSnippet(entry.text, query) });
    });
  });

  return matches
    .sort(
      (left, right) =>
        right.score - left.score || left.routeIndex - right.routeIndex || left.entryIndex - right.entryIndex,
    )
    .slice(0, limit)
    .map(({ entry, route, score, snippet }) => ({ entry, route, score, snippet }));
};

export { createDocsSearchIndex, findSearchToken, searchDocs, searchTokens };
