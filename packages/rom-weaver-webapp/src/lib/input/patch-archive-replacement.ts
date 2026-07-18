/**
 * Side-channel marker for "replace this patch card from an archive".
 *
 * The patch stack is driven by a plain list of source Files, so a replacement
 * archive has no place to carry intent through the staging pipeline. This marks
 * such a File with the name of the patch being replaced, so staging can
 * pre-select the same-named leaf in the selection picker (the user still
 * confirms or changes it). Mirrors the `__nestedParentCompressions` File
 * side-channel used for fanned-out leaves.
 */

/** The replacement intent recorded on a source, and threaded into staging as
 * `patchLeafPreference`. `preferredName` (when set) names the leaf to pre-select
 * in the picker. */
type PatchArchiveReplacement = {
  /** Base file name of the patch being replaced, matched against the archive's
   * patch leaves so the same-named one is pre-selected in the picker. */
  preferredName?: string;
};

type PatchArchiveReplacementSource = {
  __patchArchiveReplacement?: PatchArchiveReplacement;
};

/** Mark `source` as an archive replacement that pre-selects the same-named leaf.
 * Returns the same source for chaining. */
const markPatchArchiveReplacement = <TSource extends object>(source: TSource, preferredName?: string): TSource => {
  const trimmed = preferredName?.trim();
  const marker: PatchArchiveReplacement = {};
  if (trimmed) marker.preferredName = trimmed;
  (source as TSource & PatchArchiveReplacementSource).__patchArchiveReplacement = marker;
  return source;
};

/** Read the replacement intent off a staged source, or undefined for a normal
 * (non-replacement) source. */
const getPatchArchiveReplacement = (source: unknown): PatchArchiveReplacement | undefined => {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as PatchArchiveReplacementSource).__patchArchiveReplacement;
};

export { getPatchArchiveReplacement, markPatchArchiveReplacement, type PatchArchiveReplacement };
