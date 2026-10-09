import { useMemo } from "react";
import type { WeaveApplySession } from "../../lib/weave/weave-session-model.ts";
import type { PatchValidationPlan } from "../../wasm/index.ts";
import type { useUiLocalizer } from "./settings-context.tsx";
import type { useApplyPatchEnablement } from "./use-apply-patch-enablement.ts";
import type { useWeaveApplySession } from "./use-weave-apply-session.ts";

export const getApplyOutputVerification = ({
  weaveChainStatus,
  weaveOutputChecksum,
  chainPlans,
  enabledPatchCount,
  localizer,
}: {
  weaveChainStatus: string | null;
  weaveOutputChecksum: string | null;
  chainPlans: ReadonlyMap<string, PatchValidationPlan>;
  enabledPatchCount: number;
  localizer: ReturnType<typeof useUiLocalizer>;
}): { level: "warn"; message: string } | null => {
  if (enabledPatchCount <= 0) return null;
  const finalEntries: Array<{ enforceable: boolean }> = [];
  let orderIssue = false;
  let inputIssue = false;
  for (const plan of chainPlans.values()) {
    for (const entry of plan.output_verification) {
      if (entry.patch_index === plan.patch_count - 1) finalEntries.push(entry);
    }
    for (const verdict of plan.per_patch) {
      if (verdict.expected_predecessor !== undefined) orderIssue = true;
      if (verdict.input_verdict === "failed") inputIssue = true;
    }
  }
  if (finalEntries.length) {
    if (finalEntries.every((entry) => entry.enforceable)) return null;
    if (orderIssue) return { level: "warn", message: localizer.message("ui.output.outOfOrder") };
    if (inputIssue) return { level: "warn", message: localizer.message("ui.output.inputMismatch") };
    return { level: "warn", message: localizer.message("ui.output.differentChain") };
  }
  if (weaveOutputChecksum && weaveChainStatus) {
    if (weaveChainStatus === "full" || weaveChainStatus === "partial") return null;
    return { level: "warn", message: localizer.message("ui.output.weaveDiverged") };
  }
  return null;
};

type ApplyWeaveChainStatusInput = {
  activeWeaveSession: WeaveApplySession | null;
  weaveMetaById: ReturnType<typeof useWeaveApplySession>["weaveMetaById"];
  currentPatchNames: readonly string[];
  disabledPatchIds: ReturnType<typeof useApplyPatchEnablement>["disabledPatchIds"];
};

/** How the apply bench relates to the loaded weave's authored chain, and whether it is that chain. */
const useApplyWeaveChainStatus = ({
  activeWeaveSession,
  weaveMetaById,
  currentPatchNames,
  disabledPatchIds,
}: ApplyWeaveChainStatusInput) => {
  // How the current bench relates to the loaded weave's authored chain:
  // - "full": every weave patch enabled, in weave order, nothing foreign -
  //   the only state the weave's expected output describes.
  // - "partial": same chain, but at least one patch toggled off.
  // - "diverged": the patch list itself differs (append/remove/reorder/foreign).
  const weaveChainStatus = useMemo((): "full" | "partial" | "diverged" | null => {
    const session = activeWeaveSession;
    if (!(session?.entries.length && weaveMetaById.size && currentPatchNames.length)) return null;
    const expected = session.entries.map((entry) => entry.fileName);
    const namesMatch =
      currentPatchNames.length === expected.length &&
      expected.every((name, index) => currentPatchNames[index] === name);
    if (!namesMatch) return "diverged";
    return disabledPatchIds.size ? "partial" : "full";
  }, [activeWeaveSession, weaveMetaById, currentPatchNames, disabledPatchIds]);

  const weaveSessionMatches = useMemo(() => {
    const session = activeWeaveSession;
    if (!(session?.entries.length && currentPatchNames.length)) return false;
    const expected = session.entries.map((entry) => entry.fileName);
    return (
      currentPatchNames.length === expected.length && expected.every((name, index) => currentPatchNames[index] === name)
    );
  }, [activeWeaveSession, currentPatchNames]);

  return { weaveChainStatus, weaveSessionMatches };
};

export { useApplyWeaveChainStatus };
