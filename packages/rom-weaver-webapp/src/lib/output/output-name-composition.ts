const PATCH_PREFIX_SEPARATOR_REGEX = /^[\s._\-:+|/\\]+/;
const PATCH_PREFIX_BOUNDARY_REGEX = /^[\s._\-:+|/\\()[\]]/;
// Trailing `[label]` in a patch name (for example `super awesome [big jump by foo v1.0]`).
const PATCH_BRACKET_LABEL_REGEX = /\[([^\]]+)\]\s*$/;

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
    const bracketLabel = name.match(PATCH_BRACKET_LABEL_REGEX)?.[1]?.trim();
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
