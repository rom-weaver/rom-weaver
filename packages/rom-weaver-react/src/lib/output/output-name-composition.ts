const PATCH_PREFIX_SEPARATOR_REGEX = /^[\s._\-:+|/\\]+/;
const PATCH_PREFIX_BOUNDARY_REGEX = /^[\s._\-:+|/\\()[\]]/;

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

const buildPatchedOutputBaseName = (inputBaseName: string, patchNames: readonly string[]) => {
  const base = String(inputBaseName || "").trim() || "patched";
  const normalizedPatchNames = patchNames
    .map((patchName) => stripRedundantPatchPrefix(base, patchName))
    .map((patchName) => patchName.trim())
    .filter(Boolean);
  return normalizedPatchNames.length ? `${base} - ${normalizedPatchNames.join(" + ")}` : base;
};

export { buildPatchedOutputBaseName };
