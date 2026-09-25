import type { Localizer } from "../../presentation/localization/index.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { useExpectedRomIdentification } from "./use-expected-rom-identification.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { PatchInputBasis } from "./patch-input-basis.ts";

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
  const targetLabel = item.targetOptions?.find((option) => option.value === item.targetValue)?.label;
  const checkedTarget =
    targetLabel ||
    localizer.message(hasImplicitPredecessor ? "ui.patchChecks.precedingPatchOutput" : "ui.patchInputs.original");
  if (!verdict) {
    if (item.validationState === "deferred") {
      return { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) };
    }
    if (item.validationState === "valid") {
      return { text: localizer.message("ui.patchChecks.verified") };
    }
    return { text: localizer.message("ui.patchChecks.unknown", { input: checkedTarget }) };
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
  if (verdict.matched.kind === "patch_output") {
    const predecessor = displayPatch(verdict.matched.index);
    return item.validationState === "deferred"
      ? { text: localizer.message("ui.patchChecks.deferred", { input: predecessor }) }
      : { text: localizer.message("ui.patchChecks.verified") };
  }
  if (verdict.matched.kind === "base") {
    return item.validationState === "deferred"
      ? { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) }
      : { text: localizer.message("ui.patchChecks.verified") };
  }
  if (item.validationState === "deferred") {
    return { text: localizer.message("ui.patchChecks.deferred", { input: checkedTarget }) };
  }
  if (item.validationState === "valid") {
    return { text: localizer.message("ui.patchChecks.verified") };
  }
  return { text: localizer.message("ui.patchChecks.unknown", { input: checkedTarget }) };
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
export const IdentifiedCheckTitle = ({ checks, enabled }: { checks?: ParsedBundleChecks; enabled: boolean }) => {
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
