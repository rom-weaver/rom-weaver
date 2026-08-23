import type { ParsedIdentifyResolution } from "../types/identify.ts";
import { uniqueIdentifyTitles } from "./identify-title.ts";

/**
 * A create-patch pair only disagrees when BOTH sides carry a confident database
 * hit and the two title sets do not overlap. A hacked ROM normally reports
 * `unknown`, and `ambiguous`/`unavailable` are not evidence of anything, so
 * treating any of them as a mismatch would fire on the common case.
 */
const identifySourceMismatch = (
  original: ParsedIdentifyResolution | undefined,
  modified: ParsedIdentifyResolution | undefined,
): { modifiedTitle: string; originalTitle: string } | null => {
  if (original?.status !== "matched" || modified?.status !== "matched") return null;
  const originalTitles = uniqueIdentifyTitles(original.matches.map((match) => match.name));
  const modifiedTitles = uniqueIdentifyTitles(modified.matches.map((match) => match.name));
  const [originalTitle] = originalTitles;
  const [modifiedTitle] = modifiedTitles;
  if (!(originalTitle && modifiedTitle)) return null;
  if (originalTitles.some((title) => modifiedTitles.includes(title))) return null;
  return { modifiedTitle, originalTitle };
};

const identifySourceMismatchMessage = ({
  modifiedTitle,
  originalTitle,
}: {
  modifiedTitle: string;
  originalTitle: string;
}) =>
  `The two ROMs identify as different games: "${originalTitle}" and "${modifiedTitle}". A patch built from them will not apply cleanly.`;

export { identifySourceMismatch, identifySourceMismatchMessage };
