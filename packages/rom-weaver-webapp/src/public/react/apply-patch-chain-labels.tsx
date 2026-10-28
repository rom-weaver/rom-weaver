import type { Localizer } from "../../presentation/localization/index.ts";
import type { ParsedWeaveChecks } from "../../types/weave.ts";
import { useExpectedRomIdentification } from "./use-expected-rom-identification.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import { isPatchFileChecksumFailure } from "./patch-validation-failure.ts";

/** The chain chip: one plain-language line for what this patch's input was matched against.
 * Positions in the verdict are 0-based ENABLED-chain positions; `enabledIndexes` maps them to
 * the list numbering the drag handles use. Quiet by design: single-patch stacks show only the
 * identity verdicts. */
export const chainChipText = (
  item: PatchStackItemState,
  hasImplicitPredecessor: boolean,
  enabledIndexes: readonly number[],
  localizer: Localizer,
  patchLabels: readonly string[],
): { text: string; warn?: boolean } | null => {
  const verdict = item.chainVerdict;
  if (item.validationState === "invalid" && isPatchFileChecksumFailure(item.validationMessage)) {
    return { text: localizer.message("ui.patchChecks.corrupt"), warn: true };
  }
  // The patch itself is unreadable, so no ROM was checked and the chip must not blame the ROM.
  if (item.validationUnreadable) return { text: localizer.message("ui.patchChecks.unreadable"), warn: true };
  // "Verified" claims a checksum matched; a patch that merely applied (IPS, or no checksum to
  // compare) is only "Checked".
  const passedText = (matchedKnownState: boolean) =>
    localizer.message(
      matchedKnownState || item.checksumCompared ? "ui.patchChecks.verified" : "ui.patchChecks.applied",
    );
  const targetLabel = item.targetOptions?.find((option) => option.value === item.targetValue)?.label;
  const checkedTarget =
    targetLabel ||
    localizer.message(hasImplicitPredecessor ? "ui.patchChecks.precedingPatchOutput" : "ui.patchInputs.original");
  if (!verdict) {
    if (item.validationState === "deferred") {
      return { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) };
    }
    if (item.validationState === "valid") {
      return { text: passedText(false) };
    }
    if (item.validationState === "invalid") {
      return { text: localizer.message("ui.patchChecks.failed", { input: checkedTarget }), warn: true };
    }
    return { text: localizer.message("ui.patchChecks.unknown") };
  }
  const displayNumber = (enabledPosition: number) => (enabledIndexes[enabledPosition] ?? enabledPosition) + 1;
  const displayPatch = (enabledPosition: number) => {
    const index = enabledIndexes[enabledPosition] ?? enabledPosition;
    return patchLabels[index] || localizer.message("ui.patchChecks.patchNumber", { n: displayNumber(enabledPosition) });
  };
  if (item.validationState === "invalid" && verdict.matched.kind === "none" && verdict.basisSource !== "default") {
    return { text: localizer.message("ui.chain.differentRom"), warn: true };
  }
  if (verdict.expectedPredecessor !== undefined) {
    return {
      text: localizer.message("ui.patchChecks.expects", { patch: displayPatch(verdict.expectedPredecessor) }),
      warn: true,
    };
  }
  if (item.validationState === "invalid") {
    return { text: localizer.message("ui.patchChecks.failed", { input: checkedTarget }), warn: true };
  }
  if (verdict.matched.kind === "patch_output") {
    const predecessor = displayPatch(verdict.matched.index);
    return item.validationState === "deferred"
      ? { text: localizer.message("ui.patchChecks.deferred", { input: predecessor }) }
      : { text: passedText(true) };
  }
  if (verdict.matched.kind === "base") {
    return item.validationState === "deferred"
      ? { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) }
      : { text: passedText(true) };
  }
  if (item.validationState === "deferred") {
    return { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) };
  }
  if (item.validationState === "valid") {
    return { text: passedText(false) };
  }
  if (item.validationState === "invalid") {
    return { text: localizer.message("ui.patchChecks.failed", { input: checkedTarget }), warn: true };
  }
  return { text: localizer.message("ui.patchChecks.unknown") };
};

export const resolvedBasisLabel = (
  basis: PatchInputBasis,
  localizer: Localizer,
  verdictBasis?: "base" | "previous",
): string => {
  if (basis === "auto") {
    if (verdictBasis === "base") return localizer.message("ui.basis.autoBase");
    if (verdictBasis === "previous") return localizer.message("ui.basis.autoPrevious");
    return localizer.message("ui.patchInputs.auto");
  }
  return basis === "base" ? localizer.message("ui.patchInputs.original") : localizer.message("ui.patchInputs.previous");
};

export const checkInputBasisLabel = (
  basis: PatchInputBasis,
  localizer: Localizer,
  verdictBasis?: "base" | "previous",
): string => {
  if (basis === "auto") {
    if (verdictBasis === "base") return localizer.message("ui.patchChecks.autoBase");
    if (verdictBasis === "previous") return localizer.message("ui.patchChecks.autoPrevious");
    return localizer.message("ui.patchChecks.automatic");
  }
  return basis === "base" ? localizer.message("ui.patchInputs.original") : localizer.message("ui.patchInputs.previous");
};
/**
 * The database title behind a declared check state, so a drawer group names the
 * ROM its checksums describe. A per-track check matches a multi-track record
 * only partially, and the title is still the right one, so any `matched`
 * resolution is shown.
 */
export const IdentifiedCheckTitle = ({ checks, enabled }: { checks?: ParsedWeaveChecks; enabled: boolean }) => {
  const localizer = useUiLocalizer();
  const hasChecksums = !!Object.keys(checks?.checksums || {}).length;
  const identification = useExpectedRomIdentification(hasChecksums ? checks : undefined, enabled && hasChecksums);
  const match = identification?.status === "matched" ? identification.matches[0] : undefined;
  if (!match) return null;
  // Redump-style names already carry the region as its own word or bracketed
  // tag, so it is only appended when the name has no such word.
  const region = match.region?.trim();
  const carriesRegion =
    !!region &&
    new RegExp(`(^|[\\s(,])${region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s),])`, "i").test(match.name);
  const title = region && !carriesRegion ? `${match.name} (${region})` : match.name;
  return (
    <span className="ck-group-title">
      {localizer.message("ui.patchChecks.identified", { platform: match.platform, title })}
    </span>
  );
};
