import type { Localizer } from "../../presentation/localization/index.ts";
import {
  CHECK_HEX_LENGTHS,
  type CheckAlgorithm,
  type CheckField,
  normalizeCheckInput,
} from "./components/ds/check-fields.ts";

/** A ROM's computed identity values, used to verify user-entered input checks. */
export type RomCheckActuals = { crc32?: string; md5?: string; sha1?: string; bytes?: number };

/** Compare a committed (already-valid) input check to the real ROM value.
 * Returns undefined when there is nothing to compare against (the ROM value has
 * not been computed, or the field is empty). */
export const matchInputCheck = (
  field: CheckField,
  value: string,
  actuals?: RomCheckActuals,
): "bad" | "ok" | undefined => {
  if (!(actuals && value)) return undefined;
  if (field === "bytes") {
    if (typeof actuals.bytes !== "number") return undefined;
    return Number(value) === actuals.bytes ? "ok" : "bad";
  }
  const actual = (actuals[field] || "").trim().toLowerCase();
  if (!actual) return undefined;
  return normalizeCheckInput(value) === actual ? "ok" : "bad";
};

/** Why a committed check value failed validation - shown inline under the field
 * and as its title. */
export const checkErrorMessage = (field: CheckField, localizer: Localizer): string =>
  field === "bytes"
    ? localizer.message("ui.patch.expectedWholeBytes")
    : localizer.message("ui.patch.expectedHexCharacters", { count: CHECK_HEX_LENGTHS[field as CheckAlgorithm] });
