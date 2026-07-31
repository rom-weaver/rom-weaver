/**
 * @typedef {{ id: string | null, label: string, text: string }} SearchEntry
 * @typedef {{ description: string, html: string, label: string, sections: readonly { id: string, label: string }[], slug: string, title: string }} SearchSourceRoute
 * @typedef {SearchSourceRoute & { searchEntries: readonly SearchEntry[] }} SearchRoute
 * @typedef {{ entry: SearchEntry, route: SearchRoute, routeIndex: number, entryIndex: number, score: number, snippet: string }} SearchMatch
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

/** @param {SearchSourceRoute} route @returns {SearchRoute} */
const indexRoute = (route) => {
  if (typeof document === "undefined") {
    return { ...route, searchEntries: [{ id: null, label: route.title, text: `${route.title} ${route.description}` }] };
  }

  const template = document.createElement("template");
  template.innerHTML = route.html;
  const children = [...template.content.children];
  const headings = children.filter((element) => element.tagName === "H2");
  /** @param {Element[]} elements */
  const textOf = (elements) =>
    elements
      .map((element) => element.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  const firstHeading = headings[0];
  const firstHeadingIndex = firstHeading ? children.indexOf(firstHeading) : -1;
  /** @type {SearchEntry[]} */
  const entries = [
    {
      id: null,
      label: route.title,
      text: `${route.title} ${route.description} ${textOf(children.slice(0, firstHeadingIndex < 0 ? children.length : firstHeadingIndex))}`.trim(),
    },
  ];
  headings.forEach((heading, index) => {
    const section = route.sections[index];
    if (!section) return;
    const start = children.indexOf(heading);
    const nextHeading = headings[index + 1];
    const next = nextHeading ? children.indexOf(nextHeading) : -1;
    entries.push({
      id: section.id,
      label: section.label,
      text: textOf(children.slice(start, next < 0 ? children.length : next)),
    });
  });
  return { ...route, searchEntries: entries };
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

export { createDocsSearchIndex, searchDocs, searchTokens };
