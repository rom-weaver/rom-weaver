import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { ParsedIdentifyResolution } from "../../types/identify.ts";

/** One choosable platform: the pack slug the search loads, and its display name. */
type ExpectedRomPlatform = {
  platform: string;
  slug: string;
};

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
  if (candidate.status === "unavailable") {
    // The reason names the pack, HTTP status, or digest mismatch behind the
    // failure. Carry it so the caller can show a cause instead of a dead end.
    return {
      matches: [],
      status: "unavailable",
      ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}),
    };
  }
  if (!candidate.matches.length) return undefined;
  return { matches: candidate.matches, status: candidate.status };
};

/**
 * The platforms a name search can be scoped to. Same seam as
 * {@link lookupExpectedRom}, so a test replaces one module for both.
 */
const listExpectedRomPlatforms = async (): Promise<ExpectedRomPlatform[]> => {
  const { listIdentifyPlatforms } = await import("../../platform/browser/identify-packs.ts");
  return listIdentifyPlatforms();
};

/**
 * Search one platform's identify pack by game name. Resolves to `undefined`
 * when the search found nothing, and to an `unavailable` resolution when the
 * database itself could not be read - the two are different answers and the
 * caller MUST NOT report the second as "no match".
 */
const searchExpectedRomByName = async (
  platform: string,
  query: string,
  options: ExpectedRomLookupOptions & { limit?: number } = {},
): Promise<ParsedIdentifyResolution | undefined> => {
  const { identifyName } = await import("../../platform/browser/browser-api.ts");
  const result = await identifyName(platform, query, options);
  const candidate = result.candidates[0];
  if (!candidate) return undefined;
  if (candidate.status === "unavailable") {
    return {
      matches: [],
      status: "unavailable",
      ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}),
    };
  }
  if (!candidate.matches.length) return undefined;
  return { matches: candidate.matches, status: candidate.status };
};

export { listExpectedRomPlatforms, lookupExpectedRom, searchExpectedRomByName };
export type { ExpectedRomPlatform };
