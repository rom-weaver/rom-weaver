// Apply static-response _headers rules in preview so audits see the deployment headers.
// Pages Functions set their own headers: https://developers.cloudflare.com/pages/configuration/headers/
//
// Only the subset of the `_headers` syntax the build emits is supported: a path pattern
// line at column zero, then indented `Name: value` lines. `*` matches any run of
// characters including `/`, which is how Pages treats a splat.

const PATTERN_ESCAPE = /[.+?^${}()|[\]\\]/g;

const patternToRegExp = (pattern) => new RegExp(`^${pattern.replace(PATTERN_ESCAPE, "\\$&").replaceAll("*", ".*")}$`);

export const parsePagesHeaders = (text) => {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ headers: [], match: patternToRegExp(line.trim()) });
      continue;
    }
    const at = line.indexOf(":");
    // An indented line before any pattern has nothing to attach to; Pages ignores it.
    if (at === -1 || rules.length === 0) continue;
    rules.at(-1).headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return rules;
};

// Later rules win over earlier ones for the same header, which is how the emitted file is
// ordered - the broad `/*` block first, then the narrower paths that refine it. `Link` is
// the exception: it is a list header, so matches accumulate instead of replacing.
export const matchPagesHeaders = (rules, pathname) => {
  const matched = {};
  for (const rule of rules) {
    if (!rule.match.test(pathname)) continue;
    for (const [name, value] of rule.headers) {
      if (name.toLowerCase() !== "link") {
        matched[name] = value;
        continue;
      }
      matched.Link ??= [];
      matched.Link.push(value);
    }
  }
  return matched;
};
