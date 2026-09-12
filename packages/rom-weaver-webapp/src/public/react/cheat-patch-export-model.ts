import { getCreatePatchFormatsForSizes } from "../../lib/create/patch-format-limits.ts";
import type { CreateSettings } from "../../platform/browser/browser-api.ts";
import { cheatDelivery, type ClassifiedCheatRecord } from "../../lib/cheats/index.ts";
import { getFileNameWithoutExtension } from "../../lib/input/path-utils.ts";
import { sanitizeCheatPatchNamePart, toCheatPatchNameSuffix } from "./cheat-patch-name.ts";

/**
 * Pure projections for "Save as patch" on the apply workflow's Cheats step: it
 * bakes the ROM cheats that are On into a standalone patch. A cheat the decoder
 * could not resolve into ROM writes is not selectable, so nothing is left out.
 */

/** How many cheat descriptions the file name spells out before "and N more". */
const MAX_NAMED_CHEATS = 3;

/** The ROM cheats among the selection, in selection order. */
const getRomCheats = (records: readonly ClassifiedCheatRecord[]): ClassifiedCheatRecord[] =>
  records.filter((entry) => cheatDelivery(entry) === "rom");

/** The raw codes to hand to patch-create, skipping records with no code text. */
const getCheatPatchCodes = (records: readonly ClassifiedCheatRecord[]): string[] =>
  getRomCheats(records)
    .map((entry) => String(entry.record.rawCode || "").trim())
    .filter((code) => !!code);

/** The patch format the create workflow accepts. */
type CreatePatchFormat = NonNullable<CreateSettings["format"]>;

/** Prefer IPS, then BPS, among the formats allowed by the shared size policy. */
const CHEAT_PATCH_FORMAT_PREFERENCE = ["ips", "bps"] as const;

/**
 * Cheat export MUST use the shared create-size policy because the workflow
 * rejects excluded formats with UNSUPPORTED_FORMAT.
 */
const getCheatPatchFormat = (romSize: number | undefined): CreatePatchFormat => {
  const allowed = getCreatePatchFormatsForSizes(romSize);
  return (CHEAT_PATCH_FORMAT_PREFERENCE.find((format) => allowed.includes(format)) || allowed[0]) as CreatePatchFormat;
};

/**
 * The download name: the ROM's title, up to three cheat descriptions joined
 * with " + ", and "and N more" for the rest - "Zelda - A + B + C and 2 more.ips".
 */
const getCheatPatchFileName = (romTitle: string, records: readonly ClassifiedCheatRecord[], format: string): string => {
  const stem = sanitizeCheatPatchNamePart(getFileNameWithoutExtension(String(romTitle || "").trim())) || "patch";
  const descriptions = getRomCheats(records)
    .map((entry) => entry.record.description.trim())
    .filter((description) => !!description);
  const named = descriptions.slice(0, MAX_NAMED_CHEATS).join(" + ");
  const remaining = descriptions.length - Math.min(descriptions.length, MAX_NAMED_CHEATS);
  const suffix = named ? `${named}${remaining ? ` and ${remaining} more` : ""}` : "cheats";
  return `${stem} - ${toCheatPatchNameSuffix(suffix) || "cheats"}.${String(format || "ips").toLowerCase()}`;
};

/** The line shown under the cards after a successful export. */
const getCheatPatchStatus = (fileName: string, romCount: number): string =>
  `Created ${fileName} from the ${romCount} ROM cheat${romCount === 1 ? "" : "s"} that ${romCount === 1 ? "is" : "are"} On.`;

export { getCheatPatchCodes, getCheatPatchFileName, getCheatPatchFormat, getCheatPatchStatus, getRomCheats };
