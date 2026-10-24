import { toBundleCreateResult } from "../../lib/runtime/bundle-runtime.ts";
import { type RefObject, useCallback, useEffect } from "react";
import type { ApplyWorkflow } from "../../platform/browser/browser-api.ts";
import type { ApplyWorkflowWeaveSources } from "../../types/apply-workflow.ts";
import { resolveWeaveArchiveFormat, useWeaveExport } from "./weave-export.tsx";
import type { WeaveCheatSelection } from "./weave-cheat-export.ts";
import type { useLocalApplyPatchFormSession } from "./patcher-form-session.ts";
import type { PatchInputBasis } from "./patch-input-basis.ts";
import type { ApplyPatchFormProps } from "./public-types.ts";
import type { useApplyPatchEnablement } from "./use-apply-patch-enablement.ts";
import type { useWeaveApplySession } from "./use-weave-apply-session.ts";
import type { createWorkflowHandle } from "./workflow-loader.ts";

type ApplyFormSession = ReturnType<typeof useLocalApplyPatchFormSession>;
type ApplyPatchEnablement = ReturnType<typeof useApplyPatchEnablement>;

type ApplyWeaveExportInput = {
  /** Set while any patch, enabled or not, has a malformed checks draft; blocks export. */
  weaveValidationError?: string | null;
  getCheats: () => readonly WeaveCheatSelection[];
  cheatsOn: boolean;
  getSessionSources: () => Promise<ApplyWorkflowWeaveSources>;
  sourcesRevision?: string;
  weaveMetaById: ReturnType<typeof useWeaveApplySession>["weaveMetaById"];
  weaveSourcesRef: RefObject<ApplyWorkflowWeaveSources | null>;
  defaultWeaveContents: "patches" | "rom";
  defaultWeaveFormat: ReturnType<typeof resolveWeaveArchiveFormat>;
  disabledPatchIds: ApplyPatchEnablement["disabledPatchIds"];
  getPatchIds: ApplyPatchEnablement["getPatchIds"];
  mutationQueueRef: RefObject<Promise<void>>;
  outputState: ReturnType<ApplyFormSession["localOutputController"]["getState"]>;
  patchInputBasis: PatchInputBasis;
  preparedWorkflowRef: RefObject<ApplyWorkflow | null>;
  props: Pick<
    ApplyPatchFormProps,
    "onWeaveExportComplete" | "onWeavePackageChange" | "onBundleExportComplete" | "onBundlePackageChange"
  >;
  resolvedOutputController: ApplyFormSession["localOutputController"];
  resolvedStackController: ApplyFormSession["localStackController"];
  workflowHandle: ReturnType<typeof createWorkflowHandle<ApplyWorkflow>>;
};

/** Weave export state for the apply form's sharing job, plus the package-choice callback it persists. */
const useApplyWeaveExport = ({
  weaveValidationError,
  getCheats,
  cheatsOn,
  getSessionSources,
  sourcesRevision,
  weaveMetaById,
  weaveSourcesRef,
  defaultWeaveContents,
  defaultWeaveFormat,
  disabledPatchIds,
  getPatchIds,
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
    (cheatsOn && !!stagedWeaveSources?.rom) ||
    (!!stagedWeaveSources?.rom && stagedWeaveSources.patches.length > 0) ||
    (!!weaveSourcesRef.current?.rom && weaveSourcesRef.current.patches.length > 0);
  const weaveExport = useWeaveExport({
    getCheats,
    sourcesRevision,
    weaveMetaById,
    patchBasis: patchInputBasis,
    disabledPatchIds,
    getPatchIds,
    getName: () => resolvedOutputController.getState().displayFileName,
    getOutputHeader: () => resolvedOutputController.getState().outputHeader,
    getSessionSources,
    getStackItems: () => resolvedStackController.getState().items,
    waitForPendingWork: () => mutationQueueRef.current,
    initialWeaveRom: defaultWeaveContents === "rom",
    initialFormat: defaultWeaveFormat,
    ready: weaveExportReady && !weaveValidationError,
    onComplete: (result) => {
      props.onWeaveExportComplete?.(result);
      props.onBundleExportComplete?.(toBundleCreateResult(result));
    },
  });
  const { setFormat: setWeaveExportFormat } = weaveExport;

  useEffect(() => {
    setWeaveExportFormat(resolveWeaveArchiveFormat(outputState.compressionFormat));
  }, [outputState.compressionFormat, setWeaveExportFormat]);

  // The weave package controls live in the separate sharing job. Compression
  // type selects the archive format; this callback persists only ROM inclusion.
  const { setWeaveRom: setWeaveExportRom } = weaveExport;
  const { onWeavePackageChange, onBundlePackageChange } = props;
  const changeWeavePackage = useCallback(
    (value: string) => {
      const contents = value === "rom" || value.endsWith(":rom") ? "rom" : "patches";
      setWeaveExportRom(contents === "rom");
      onWeavePackageChange?.(contents);
      onBundlePackageChange?.(contents);
    },
    [onWeavePackageChange, onBundlePackageChange, setWeaveExportRom],
  );

  return { weaveExport, changeWeavePackage };
};

export { useApplyWeaveExport };
