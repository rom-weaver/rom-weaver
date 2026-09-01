import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { ParsedIdentifyResolution } from "../../types/identify.ts";

type ExpectedRomLookupOptions = {
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void;
  signal?: AbortSignal;
};

/**
 * The apply workflow's one door to the checksum lookup, so the ROM steps hold a
 * static import of this module and reach `browser-api` only through the dynamic
 * import inside it. Tests replace this module whole; mocking `browser-api`
 * itself would have them stub the same module the apply workflow runs on.
 *
 * Resolves to `undefined` for every answer that is not one or more titles: an
 * unavailable database and an unknown checksum are both "nothing to show", not
 * a failed check.
 */
const lookupExpectedRom = async (
  checks: ParsedBundleChecks,
  options: ExpectedRomLookupOptions = {},
): Promise<ParsedIdentifyResolution | undefined> => {
  const { identifyChecks } = await import("../../platform/browser/browser-api.ts");
  const result = await identifyChecks(
    { checksums: checks.checksums || {}, ...(typeof checks.size === "number" ? { size: checks.size } : {}) },
    options,
  );
  const candidate = result.candidates[0];
  if (!candidate) return undefined;
  if (candidate.status === "unavailable") return { matches: [], status: "unavailable" };
  if (!candidate.matches.length) return undefined;
  return { matches: candidate.matches, status: candidate.status };
};

export { lookupExpectedRom };
