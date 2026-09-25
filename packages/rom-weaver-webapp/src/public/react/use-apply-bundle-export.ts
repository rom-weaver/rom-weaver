import { type RefObject, useCallback, useEffect } from "react";
import type { ApplyWorkflow } from "../../platform/browser/browser-api.ts";
import type { ApplyWorkflowBundleSources } from "../../types/apply-workflow.ts";
import { resolveBundleArchiveFormat, useBundleExport } from "./bundle-export.tsx";
import type { BinarySource } from "./patcher-form.ts";
import type { useLocalApplyPatchFormSession } from "./patcher-form-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import type { ApplyPatchFormProps } from "./public-types.ts";
import type { useApplyPatchEnablement } from "./use-apply-patch-enablement.ts";
import type { useBundleApplySession } from "./use-bundle-apply-session.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";
import type { createWorkflowHandle } from "./workflow-loader.ts";

type ApplyFormSession = ReturnType<typeof useLocalApplyPatchFormSession>;
type ApplyPatchEnablement = ReturnType<typeof useApplyPatchEnablement>;

type ApplyBundleExportInput = {
  bundleMetaById: ReturnType<typeof useBundleApplySession>["bundleMetaById"];
  bundleSourcesRef: RefObject<ApplyWorkflowBundleSources | null>;
  currentPatchesRef: RefObject<BinarySource[]>;
  defaultBundleContents: "patches" | "rom";
  defaultBundleFormat: ReturnType<typeof resolveBundleArchiveFormat>;
  disabledPatchIds: ApplyPatchEnablement["disabledPatchIds"];
  getPatchIds: ApplyPatchEnablement["getPatchIds"];
  lastInputsRef: RefObject<BinarySource[]>;
  mutationQueueRef: RefObject<Promise<void>>;
  outputState: ReturnType<ApplyFormSession["localOutputController"]["getState"]>;
  patchInputBasis: PatchInputBasis;
  preparedWorkflowRef: RefObject<ApplyWorkflow | null>;
  props: Pick<ApplyPatchFormProps, "onBundleExportComplete" | "onBundlePackageChange">;
  resolvedOutputController: ApplyFormSession["localOutputController"];
  resolvedStackController: ApplyFormSession["localStackController"];
  workflowHandle: ReturnType<typeof createWorkflowHandle<ApplyWorkflow>>;
};

/** Bundle export state for the apply form's sharing job, plus the package-choice callback it persists. */
const useApplyBundleExport = ({
  bundleMetaById,
  bundleSourcesRef,
  currentPatchesRef,
  defaultBundleContents,
  defaultBundleFormat,
  disabledPatchIds,
  getPatchIds,
  lastInputsRef,
  mutationQueueRef,
  outputState,
  patchInputBasis,
  preparedWorkflowRef,
  props,
  resolvedOutputController,
  resolvedStackController,
  workflowHandle,
}: ApplyBundleExportInput) => {
  // "Share this setup" (secondary job after the output card): snapshots the current
  // session's files + enablement into a rom-weaver-bundle.json (or everything-bundle .zip).
  const stagedBundleSources = (preparedWorkflowRef.current || workflowHandle.peek())?.getBundleExportSources();
  const bundleExportReady =
    (!!stagedBundleSources?.rom && stagedBundleSources.patches.length > 0) ||
    (!!bundleSourcesRef.current?.rom && bundleSourcesRef.current.patches.length > 0);
  const bundleExport = useBundleExport({
    bundleMetaById,
    patchBasis: patchInputBasis,
    disabledPatchIds,
    getPatchIds,
    getName: () => resolvedOutputController.getState().displayFileName,
    getOutputHeader: () => resolvedOutputController.getState().outputHeader,
    getSessionSources: (): ApplyWorkflowBundleSources => {
      const workflowSources = (preparedWorkflowRef.current || workflowHandle.peek())?.getBundleExportSources();
      if (workflowSources?.rom || workflowSources?.patches.length) return workflowSources;
      if (bundleSourcesRef.current?.rom || bundleSourcesRef.current?.patches.length) return bundleSourcesRef.current;
      return {
        patches: currentPatchesRef.current.map((source, index) => ({
          fileName: getReactBinarySourceFileName(source, `patch-${index + 1}.bin`),
          originalSource: source,
          source,
        })),
        rom: lastInputsRef.current[0]
          ? {
              fileName: getReactBinarySourceFileName(lastInputsRef.current[0], "rom.bin"),
              originalSource: lastInputsRef.current[0],
              source: lastInputsRef.current[0],
            }
          : null,
      };
    },
    getStackItems: () => resolvedStackController.getState().items,
    waitForPendingWork: () => mutationQueueRef.current,
    initialBundleRom: defaultBundleContents === "rom",
    initialFormat: defaultBundleFormat,
    ready: bundleExportReady,
    ...(props.onBundleExportComplete ? { onComplete: props.onBundleExportComplete } : {}),
  });
  const { setFormat: setBundleExportFormat } = bundleExport;

  useEffect(() => {
    setBundleExportFormat(resolveBundleArchiveFormat(outputState.compressionFormat));
  }, [outputState.compressionFormat, setBundleExportFormat]);

  // The bundle package controls live in the separate sharing job. Compression
  // type selects the archive format; this callback persists only ROM inclusion.
  const { setBundleRom: setBundleExportRom } = bundleExport;
  const { onBundlePackageChange } = props;
  const changeBundlePackage = useCallback(
    (value: string) => {
      const contents = value === "rom" || value.endsWith(":rom") ? "rom" : "patches";
      setBundleExportRom(contents === "rom");
      onBundlePackageChange?.(contents);
    },
    [onBundlePackageChange, setBundleExportRom],
  );

  return { bundleExport, changeBundlePackage };
};

export { useApplyBundleExport };
