const PATCH_PREFIX_SEPARATOR_REGEX = /^[\s._\-:+|/\\]+/;
const PATCH_PREFIX_BOUNDARY_REGEX = /^[\s._\-:+|/\\()[\]]/;
// Trailing `[label]` in a patch name (for example `super awesome [big jump by foo v1.0]`).
// Index-scanned rather than matched with `/\[([^\]]+)\]\s*$/`, whose `\[` retried at
// every bracket and made long bracket-heavy names quadratic (CodeQL js/polynomial-redos).
// The regex matched leftmost-first, so the label opens at the first `[` that still leaves
// a `]`-free run up to the final `]` (`[[a]` -> `[a`, `[a][b]` -> `b`).
const readBracketLabel = (name: string): string => {
  const trimmed = name.trimEnd();
  const close = trimmed.length - 1;
  if (close < 0 || trimmed[close] !== "]") return "";
  const previousClose = trimmed.lastIndexOf("]", close - 1);
  const open = trimmed.indexOf("[", previousClose + 1);
  if (open < 0 || open >= close) return "";
  return trimmed.slice(open + 1, close);
};

const stripRedundantPatchPrefix = (inputBaseName: string, patchName: string) => {
  const base = String(inputBaseName || "").trim();
  const patch = String(patchName || "").trim();
  if (!(base && patch)) return patch;
  if (!patch.toLowerCase().startsWith(base.toLowerCase())) return patch;
  const remainder = patch.slice(base.length);
  if (!remainder) return "";
  if (!PATCH_PREFIX_BOUNDARY_REGEX.test(remainder)) return patch;
  return remainder.replace(PATCH_PREFIX_SEPARATOR_REGEX, "").trim();
};

/**
 * Composes the patched output base name from the input name and patch names.
 *
 * A patch name ending in a `[label]` contributes that bracketed label verbatim
 * (`Crash` + `super awesome [big jump by foo v1.0]` -> `Crash [big jump by foo v1.0]`),
 * replacing the rest of the patch name. Patch names without a bracket label keep the
 * legacy ` - name + name` join.
 */
const buildPatchedOutputBaseName = (inputBaseName: string, patchNames: readonly string[]) => {
  const base = String(inputBaseName || "").trim() || "patched";
  const plainNames: string[] = [];
  const bracketLabels: string[] = [];
  for (const patchName of patchNames) {
    const name = String(patchName || "").trim();
    if (!name) continue;
    const bracketLabel = readBracketLabel(name).trim();
    if (bracketLabel) {
      bracketLabels.push(bracketLabel);
      continue;
    }
    const stripped = stripRedundantPatchPrefix(base, name).trim();
    if (stripped) plainNames.push(stripped);
  }
  const plainSuffix = plainNames.length ? ` - ${plainNames.join(" + ")}` : "";
  const bracketSuffix = bracketLabels.map((label) => ` [${label}]`).join("");
  return `${base}${plainSuffix}${bracketSuffix}`;
};

export { buildPatchedOutputBaseName };
