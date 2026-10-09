import { type RefObject, useCallback, useEffect } from "react";
import type { ApplyWorkflow } from "../../platform/browser/browser-api.ts";
import type { ApplyWorkflowWeaveSources } from "../../types/apply-workflow.ts";
import { resolveWeaveArchiveFormat, useWeaveExport } from "./weave-export.tsx";
import type { BinarySource } from "./patcher-form.ts";
import type { useLocalApplyPatchFormSession } from "./patcher-form-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import type { ApplyPatchFormProps } from "./public-types.ts";
import type { useApplyPatchEnablement } from "./use-apply-patch-enablement.ts";
import type { useWeaveApplySession } from "./use-weave-apply-session.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";
import type { createWorkflowHandle } from "./workflow-loader.ts";

type ApplyFormSession = ReturnType<typeof useLocalApplyPatchFormSession>;
type ApplyPatchEnablement = ReturnType<typeof useApplyPatchEnablement>;

type ApplyWeaveExportInput = {
  weaveMetaById: ReturnType<typeof useWeaveApplySession>["weaveMetaById"];
  weaveSourcesRef: RefObject<ApplyWorkflowWeaveSources | null>;
  currentPatchesRef: RefObject<BinarySource[]>;
  defaultWeaveContents: "patches" | "rom";
  defaultWeaveFormat: ReturnType<typeof resolveWeaveArchiveFormat>;
  disabledPatchIds: ApplyPatchEnablement["disabledPatchIds"];
  getPatchIds: ApplyPatchEnablement["getPatchIds"];
  lastInputsRef: RefObject<BinarySource[]>;
  mutationQueueRef: RefObject<Promise<void>>;
  outputState: ReturnType<ApplyFormSession["localOutputController"]["getState"]>;
  patchInputBasis: PatchInputBasis;
  preparedWorkflowRef: RefObject<ApplyWorkflow | null>;
  props: Pick<ApplyPatchFormProps, "onWeaveExportComplete" | "onWeavePackageChange">;
  resolvedOutputController: ApplyFormSession["localOutputController"];
  resolvedStackController: ApplyFormSession["localStackController"];
  workflowHandle: ReturnType<typeof createWorkflowHandle<ApplyWorkflow>>;
};

/** Weave export state for the apply form's sharing job, plus the package-choice callback it persists. */
const useApplyWeaveExport = ({
  weaveMetaById,
  weaveSourcesRef,
  currentPatchesRef,
  defaultWeaveContents,
  defaultWeaveFormat,
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
}: ApplyWeaveExportInput) => {
  // "Share this setup" (secondary job after the output card): snapshots the current
  // session's files + enablement into a rom-weaver-weave.json (or everything-weave .zip).
  const stagedWeaveSources = (preparedWorkflowRef.current || workflowHandle.peek())?.getWeaveExportSources();
  const weaveExportReady =
    (!!stagedWeaveSources?.rom && stagedWeaveSources.patches.length > 0) ||
    (!!weaveSourcesRef.current?.rom && weaveSourcesRef.current.patches.length > 0);
  const weaveExport = useWeaveExport({
    weaveMetaById,
    patchBasis: patchInputBasis,
    disabledPatchIds,
    getPatchIds,
    getName: () => resolvedOutputController.getState().displayFileName,
    getOutputHeader: () => resolvedOutputController.getState().outputHeader,
    getSessionSources: (): ApplyWorkflowWeaveSources => {
      const workflowSources = (preparedWorkflowRef.current || workflowHandle.peek())?.getWeaveExportSources();
      if (workflowSources?.rom || workflowSources?.patches.length) return workflowSources;
      if (weaveSourcesRef.current?.rom || weaveSourcesRef.current?.patches.length) return weaveSourcesRef.current;
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
    initialWeaveRom: defaultWeaveContents === "rom",
    initialFormat: defaultWeaveFormat,
    ready: weaveExportReady,
    ...(props.onWeaveExportComplete ? { onComplete: props.onWeaveExportComplete } : {}),
  });
  const { setFormat: setWeaveExportFormat } = weaveExport;

  useEffect(() => {
    setWeaveExportFormat(resolveWeaveArchiveFormat(outputState.compressionFormat));
  }, [outputState.compressionFormat, setWeaveExportFormat]);

  // The weave package controls live in the separate sharing job. Compression
  // type selects the archive format; this callback persists only ROM inclusion.
  const { setWeaveRom: setWeaveExportRom } = weaveExport;
  const { onWeavePackageChange } = props;
  const changeWeavePackage = useCallback(
    (value: string) => {
      const contents = value === "rom" || value.endsWith(":rom") ? "rom" : "patches";
      setWeaveExportRom(contents === "rom");
      onWeavePackageChange?.(contents);
    },
    [onWeavePackageChange, setWeaveExportRom],
  );

  return { weaveExport, changeWeavePackage };
};

export { useApplyWeaveExport };
