import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { formatIdentifyTitle } from "../../presentation/identify-title.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import type { RomInputRowState } from "./patcher-ui-state.ts";
import type { BundlePatchMeta } from "./use-bundle-apply-session.ts";

const ROM_CHECKSUM_HEX_LENGTHS: Record<number, "crc32" | "md5" | "sha1"> = { 8: "crc32", 32: "md5", 40: "sha1" };

/**
 * Compare a user-pasted checksum against a ROM's computed checksums, mirroring
 * the apply-time hex auto-detection (crc32/md5/sha1 by length). Undefined when
 * there is nothing to compare yet.
 */
const matchPastedInputChecksum = (pasted: string, info: RomInputRowState["info"]): "bad" | "ok" | undefined => {
  const hex = pasted.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  const algorithm = ROM_CHECKSUM_HEX_LENGTHS[hex.length];
  if (!algorithm) return undefined;
  const actual = (info[algorithm] || "").trim().toLowerCase();
  if (!actual) return undefined;
  return actual === hex ? "ok" : "bad";
};

/**
 * One "in <algo>=<value>" row off a patch card, or null when the row is not one.
 * "in min size" (xdelta) is a lower bound rather than an identity, so it never
 * matches here.
 */
const parseInputExpectationEntry = (entry: string): { key: string; value: string } | null => {
  const match = /^in (crc32|md5|sha-?1|size)=(.+)$/i.exec(entry);
  if (!match) return null;
  const key = (match[1] || "").toLowerCase().replace("sha-1", "sha1");
  const value = (match[2] || "").trim();
  return value ? { key, value } : null;
};

const parsePatchInputExpectation = (patch: PatchStackItemState): ParsedBundleChecks | undefined => {
  const checksums: Record<string, string> = {};
  let size: number | undefined;
  for (const entry of patch.validationValues || []) {
    const parsed = parseInputExpectationEntry(entry);
    if (!parsed) continue;
    if (parsed.key === "size") {
      const bytes = Number(parsed.value);
      if (Number.isFinite(bytes)) size = bytes;
      continue;
    }
    checksums[parsed.key] = parsed.value;
  }
  if (!(Object.keys(checksums).length || size !== undefined)) return undefined;
  return { checksums, ...(size === undefined ? {} : { size }) };
};

/* Pre-plan fallback: the chain-input patch (first enabled) is the one whose
   input describes the base ROM under sequential semantics. */
export const parseChainInputExpectation = (
  patches: PatchStackItemState[],
  disabledFlags?: readonly boolean[],
): ParsedBundleChecks | undefined => {
  const chainInput = patches.find((_, index) => !disabledFlags?.[index]);
  return chainInput ? parsePatchInputExpectation(chainInput) : undefined;
};

const collectPlanBaseContributions = (
  patches: PatchStackItemState[],
  disabledFlags: readonly boolean[],
  bundleMeta: ReadonlyArray<BundlePatchMeta | undefined>,
  bundleRomChecks: ParsedBundleChecks | undefined,
) => {
  const contributions: ParsedBundleChecks[] = bundleRomChecks ? [bundleRomChecks] : [];
  let sawBaseVerdict = false;
  for (const [index, patch] of patches.entries()) {
    if (disabledFlags[index] || patch.chainVerdict?.basis !== "base") continue;
    sawBaseVerdict = true;
    const expectation = bundleMeta[index]?.inputChecks ?? parsePatchInputExpectation(patch);
    if (expectation) contributions.push(expectation);
  }
  return { contributions, sawBaseVerdict };
};

/**
 * Fold one contribution's checksums into the running set. On disagreement the
 * value matching the staged ROM wins; the clash is reported so the caller can
 * flag a base conflict.
 */
const mergeChecksumContribution = (
  checksums: Record<string, string>,
  contribution: ParsedBundleChecks,
  romInfo: RomInputRowState["info"] | undefined,
): boolean => {
  let conflict = false;
  for (const [algorithm, rawValue] of Object.entries(contribution.checksums || {})) {
    const key = algorithm.toLowerCase().replace("sha-1", "sha1");
    const value = rawValue.trim().toLowerCase();
    if (!value) continue;
    const existing = checksums[key];
    if (existing === undefined || existing === value) {
      checksums[key] = value;
      continue;
    }
    conflict = true;
    const actual =
      key === "crc32" || key === "md5" || key === "sha1" ? (romInfo?.[key] || "").trim().toLowerCase() : "";
    if (actual && value === actual) checksums[key] = value;
  }
  return conflict;
};

const mergePlanBaseContributions = (
  contributions: ParsedBundleChecks[],
  romInfo: RomInputRowState["info"] | undefined,
) => {
  const checksums: Record<string, string> = {};
  let size: number | undefined;
  let conflict = false;
  for (const contribution of contributions) {
    if (mergeChecksumContribution(checksums, contribution, romInfo)) conflict = true;
    if (contribution.size === undefined) continue;
    if (size === undefined) size = contribution.size;
    else if (size !== contribution.size) conflict = true;
  }
  return { checksums, conflict, size };
};

/**
 * Plan-fed base expectation for a single-ROM bench: union the checks of every
 * base-basis patch with the bundle's rom.checks. On disagreement the value
 * matching the staged ROM wins and a base conflict is flagged (the losing
 * patch's own card shows the mismatch). Null when the plan offered no
 * base-basis verdicts - callers fall back to the chain-input parse.
 */
export const buildPlanBaseExpectation = (
  patches: PatchStackItemState[],
  disabledFlags: readonly boolean[],
  bundleMeta: ReadonlyArray<BundlePatchMeta | undefined>,
  bundleRomChecks: ParsedBundleChecks | undefined,
  romInfo: RomInputRowState["info"] | undefined,
): { conflict: boolean; expected: ParsedBundleChecks } | null => {
  const { contributions, sawBaseVerdict } = collectPlanBaseContributions(
    patches,
    disabledFlags,
    bundleMeta,
    bundleRomChecks,
  );
  if (!(sawBaseVerdict && contributions.length)) return null;
  const { checksums, conflict, size } = mergePlanBaseContributions(contributions, romInfo);
  if (!(Object.keys(checksums).length || size !== undefined)) return null;
  return { conflict, expected: { checksums, ...(size === undefined ? {} : { size }) } };
};

export const buildRomVerificationStates = (
  patches: PatchStackItemState[],
  romInputs: RomInputRowState[],
  disabledFlags: boolean[],
) => {
  const infoById = new Map(romInputs.map((rom) => [rom.id, rom.info]));
  const states = new Map<string, "bad" | "ok">();
  const apply = (romId: string, verdict: "bad" | "ok" | undefined) => {
    if (!verdict) return;
    if (verdict === "bad" || !states.has(romId)) states.set(romId, verdict);
  };
  for (const [patchIndex, patch] of patches.entries()) {
    // A toggled-off patch will not apply, so its expectations say nothing
    // about the ROM being used.
    if (disabledFlags[patchIndex]) continue;
    const romId = patch.targetValue;
    if (!romId) continue;
    apply(
      romId,
      patch.sourceChecksumState === "invalid" ? "bad" : patch.sourceChecksumState === "valid" ? "ok" : undefined,
    );
    const info = infoById.get(romId);
    if (info && patch.validateInputChecksum) apply(romId, matchPastedInputChecksum(patch.validateInputChecksum, info));
  }
  return states;
};

export type RomIdentificationState = {
  aliases?: string[];
  name?: string;
  names?: string[];
  status: "matched" | "ambiguous";
};

const getConfirmedPatchIdentification = (patch: PatchStackItemState): RomIdentificationState | undefined => {
  if (patch.validationState === "invalid") return undefined;
  if (!(patch.validationState === "valid" || patch.sourceChecksumState === "valid")) return undefined;
  const aliases = [...new Set((patch.sourceTitles || []).map((title) => title.trim()).filter(Boolean))];
  const names = [...new Set(aliases.map(formatIdentifyTitle).filter(Boolean))];
  if (!names.length) return undefined;
  const display = { aliases, names, status: names.length === 1 ? ("matched" as const) : ("ambiguous" as const) };
  return names.length === 1 ? { ...display, name: names[0] } : display;
};

export const buildRomIdentificationStates = (patches: PatchStackItemState[], disabledFlags: boolean[]) => {
  const states = new Map<string, RomIdentificationState>();
  for (const [patchIndex, patch] of patches.entries()) {
    if (disabledFlags[patchIndex] || !patch.targetValue) continue;
    const identification = getConfirmedPatchIdentification(patch);
    if (!identification) continue;
    const existing = states.get(patch.targetValue);
    if (!existing) {
      states.set(patch.targetValue, identification);
      continue;
    }
    if (
      existing.status === "ambiguous" ||
      identification.status === "ambiguous" ||
      existing.name !== identification.name
    ) {
      states.set(patch.targetValue, { status: "ambiguous" });
    }
  }
  return states;
};

export const resolveRomIdentification = (
  romInput: RomInputRowState,
  patchIdentification: RomIdentificationState | undefined,
): RomIdentificationState | undefined => {
  if (romInput.info.identificationStatus === "matched") {
    return { name: romInput.info.romInfo, status: "matched" };
  }
  if (patchIdentification?.status === "matched") return patchIdentification;
  if (romInput.info.identificationStatus === "ambiguous" || patchIdentification?.status === "ambiguous") {
    return { status: "ambiguous" };
  }
  return undefined;
};

export const buildPatchIdentificationLookup = (identification: RomIdentificationState | undefined) => {
  if (!(identification?.names?.length || identification?.name)) return undefined;
  const names = identification.names || [identification.name as string];
  const aliases = identification.aliases?.length ? identification.aliases : names;
  return {
    matches: aliases.map((name) => ({
      algorithm: "",
      database: "patch requirement",
      name,
      platform: "",
      variant: "source",
    })),
    status: identification.status,
  } as const;
};
