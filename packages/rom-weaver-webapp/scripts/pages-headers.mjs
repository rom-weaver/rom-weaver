// Apply static-response _headers rules in preview so audits see the deployment headers.
// Pages Functions set their own headers: https://developers.cloudflare.com/pages/configuration/headers/
//
// Only the subset of the `_headers` syntax the build emits is supported: a path pattern
// line at column zero, then indented `Name: value` or `! Name` lines. As in the Pages
// rules engine (workers-sdk `generateRuleRegExp`), `*` matches any run of characters
// including `/` and is substituted as `:splat`; `:name` matches one or more characters
// other than `/` and may sit inside a segment, so `/docs/:slug.md` captures `slug`.

const PATTERN_ESCAPE = /[.+?^${}()|[\]\\]/g;
const PLACEHOLDER = /:([A-Za-z]\w*)/g;

const patternToRegExp = (pattern) =>
  new RegExp(
    `^${pattern.replace(PATTERN_ESCAPE, "\\$&").replace(/\*/g, "(?<splat>.*)").replace(PLACEHOLDER, "(?<$1>[^/]+)")}$`,
  );

// Each rule keeps its header operations in file order; a `null` value is a `! Name` unset.
export const parsePagesHeaders = (text) => {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ headers: [], match: patternToRegExp(line.trim()) });
      continue;
    }
    // An indented line before any pattern has nothing to attach to; Pages ignores it.
    if (rules.length === 0) continue;
    const unset = line.trim().match(/^!\s*(\S+)$/);
    if (unset) {
      rules.at(-1).headers.push([unset[1], null]);
      continue;
    }
    const at = line.indexOf(":");
    if (at === -1) continue;
    rules.at(-1).headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return rules;
};

const substitute = (value, groups) =>
  Object.entries(groups ?? {}).reduce((result, [name, captured]) => result.replaceAll(`:${name}`, captured), value);

// Every matching rule applies in file order, as Pages does. Within a rule, `! Name` runs
// before its sets. The first rule to set a header replaces the static response's value;
// later rules append to it, so a narrower rule that must replace a broader one unsets the
// header first. `Link` stays a list (one response header per value); other headers join
// with ", " the way the Pages Headers object does.
export const matchPagesHeaders = (rules, pathname) => {
  const values = new Map();
  const names = new Map();
  const seen = new Set();
  for (const rule of rules) {
    const match = rule.match.exec(pathname);
    if (!match) continue;
    const { groups } = match;
    for (const [name, value] of rule.headers) if (value === null) values.delete(name.toLowerCase());
    for (const [name, value] of rule.headers) {
      if (value === null) continue;
      const key = name.toLowerCase();
      const resolved = substitute(value, groups);
      names.set(key, names.get(key) ?? name);
      values.set(key, seen.has(key) && values.has(key) ? [...values.get(key), resolved] : [resolved]);
      seen.add(key);
    }
  }
  const matched = {};
  for (const [key, list] of values) matched[names.get(key)] = key === "link" ? list : list.join(", ");
  return matched;
};
