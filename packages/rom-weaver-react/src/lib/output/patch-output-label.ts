// Trailing `[label]` tag in a patch *file name*, tolerating an extension and a
// copy suffix (e.g. `Game [Hack by foo].ips`, `Game [Hack].bps`, `Game [Hack] (1)`).
// Display-only: the label becomes the generated output name. Not part of the
// sidecar match rule — Rust owns that — so it stays on the host side.
const PATCH_FILE_LABEL_PATTERN = /\[([^\]]+)\](?:\.[^.]+)?\d*$/;

/** Extract a trailing `[label]` from a patch file name, or `undefined` when absent. */
const extractPatchFileLabel = (fileName: string | undefined): string | undefined => {
  const label = String(fileName || "")
    .match(PATCH_FILE_LABEL_PATTERN)?.[1]
    ?.trim();
  return label || undefined;
};

export { extractPatchFileLabel };
