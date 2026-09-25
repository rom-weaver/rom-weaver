import { useMemo } from "react";
import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import type { PatchValidationPlan } from "../../wasm/index.ts";
import type { useUiLocalizer } from "./settings-context.tsx";
import type { useApplyPatchEnablement } from "./use-apply-patch-enablement.ts";
import type { useBundleApplySession } from "./use-bundle-apply-session.ts";

export const getApplyOutputVerification = ({
  bundleChainStatus,
  bundleOutputChecksum,
  chainPlans,
  enabledPatchCount,
  localizer,
}: {
  bundleChainStatus: string | null;
  bundleOutputChecksum: string | null;
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
  if (bundleOutputChecksum && bundleChainStatus) {
    if (bundleChainStatus === "full" || bundleChainStatus === "partial") return null;
    return { level: "warn", message: localizer.message("ui.output.bundleDiverged") };
  }
  return null;
};

type ApplyBundleChainStatusInput = {
  activeBundleSession: BundleApplySession | null;
  bundleMetaById: ReturnType<typeof useBundleApplySession>["bundleMetaById"];
  currentPatchNames: readonly string[];
  disabledPatchIds: ReturnType<typeof useApplyPatchEnablement>["disabledPatchIds"];
};

/** How the apply bench relates to the loaded bundle's authored chain, and whether it is that chain. */
const useApplyBundleChainStatus = ({
  activeBundleSession,
  bundleMetaById,
  currentPatchNames,
  disabledPatchIds,
}: ApplyBundleChainStatusInput) => {
  // How the current bench relates to the loaded bundle's authored chain:
  // - "full": every bundle patch enabled, in bundle order, nothing foreign -
  //   the only state the bundle's expected output describes.
  // - "partial": same chain, but at least one patch toggled off.
  // - "diverged": the patch list itself differs (append/remove/reorder/foreign).
  const bundleChainStatus = useMemo((): "full" | "partial" | "diverged" | null => {
    const session = activeBundleSession;
    if (!(session?.entries.length && bundleMetaById.size && currentPatchNames.length)) return null;
    const expected = session.entries.map((entry) => entry.fileName);
    const namesMatch =
      currentPatchNames.length === expected.length &&
      expected.every((name, index) => currentPatchNames[index] === name);
    if (!namesMatch) return "diverged";
    return disabledPatchIds.size ? "partial" : "full";
  }, [activeBundleSession, bundleMetaById, currentPatchNames, disabledPatchIds]);

  const bundleSessionMatches = useMemo(() => {
    const session = activeBundleSession;
    if (!(session?.entries.length && currentPatchNames.length)) return false;
    const expected = session.entries.map((entry) => entry.fileName);
    return (
      currentPatchNames.length === expected.length && expected.every((name, index) => currentPatchNames[index] === name)
    );
  }, [activeBundleSession, currentPatchNames]);

  return { bundleChainStatus, bundleSessionMatches };
};

export { useApplyBundleChainStatus };
