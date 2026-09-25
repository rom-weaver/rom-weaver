import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";

const CHECKSUM_HEX_LENGTHS: Record<string, number> = { crc32: 8, md5: 32, sha1: 40 };

/** The patch's own "in <algo>=" / "out <algo>=" row for this side, if it has one. */
const readEmbeddedCheck = (
  patch: PatchStackItemState | undefined,
  side: "input" | "output",
  normalizedAlgorithm: string,
) => {
  const prefix = side === "input" ? "in " : "out ";
  return patch?.validationValues
    .map((entry) => entry.split("=", 2))
    .find(([label]) => label?.trim().toLowerCase().replace("sha-1", "sha1") === `${prefix}${normalizedAlgorithm}`)?.[1]
    ?.trim()
    .toLowerCase();
};

/**
 * Check one declared checksum against its expected hex shape and against what the
 * patch itself embeds. Returns "" when the value is fine.
 */
const checkDeclaredChecksum = (input: {
  algorithm: string;
  index: number;
  localizer: ReturnType<typeof useUiLocalizer>;
  patch: PatchStackItemState | undefined;
  rawValue: string;
  side: "input" | "output";
}): string => {
  const { algorithm, index, localizer, side } = input;
  const normalizedAlgorithm = algorithm.toLowerCase().replace("sha-1", "sha1");
  const value = input.rawValue.trim().toLowerCase();
  if (!value) return "";
  const length = CHECKSUM_HEX_LENGTHS[normalizedAlgorithm];
  if (!(length && new RegExp(`^[0-9a-f]{${length}}$`).test(value))) {
    return localizer.message("ui.apply.validation.malformedChecksum", {
      algorithm: algorithm.toUpperCase(),
      index: index + 1,
      side,
    });
  }
  const embedded = readEmbeddedCheck(input.patch, side, normalizedAlgorithm);
  if (embedded && embedded !== value) {
    return localizer.message("ui.apply.validation.conflictingChecksum", {
      algorithm: algorithm.toUpperCase(),
      index: index + 1,
      side,
    });
  }
  return "";
};

export const getBundleVerificationError = (
  bundleMeta: Array<BundlePatchMeta | undefined>,
  patches: PatchStackItemState[],
  localizer: ReturnType<typeof useUiLocalizer>,
) => {
  for (const [index, meta] of bundleMeta.entries()) {
    for (const [side, checks] of [
      ["input", meta?.inputChecks?.checksums],
      ["output", meta?.outputChecks?.checksums],
    ] as const) {
      for (const [algorithm, rawValue] of Object.entries(checks || {})) {
        const error = checkDeclaredChecksum({ algorithm, index, localizer, patch: patches[index], rawValue, side });
        if (error) return error;
      }
    }
  }
  return "";
};
