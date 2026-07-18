import { type Dispatch, type SetStateAction, useMemo } from "react";
import { createLogger } from "../../lib/logging.ts";
import { createRomInputRow } from "./apply-session-inputs.ts";
import { getTraceSourceSummaries, getTraceSourceSummary, logUiError } from "./apply-session-logging.ts";
import type { useLocalPatcherSessionState } from "./apply-session-state.ts";
import type {
  ApplyWorkflowStageSnapshot,
  LocalApplyPatchFormSessionOptions,
  StagedInputInfo,
} from "./apply-session-types.ts";
import { reorder } from "./components/ds/use-list-reorder.ts";
import type { ApplyPatchFormSettings, BinarySource } from "./patcher-form.ts";
import { toError } from "./patcher-form-session-utils.ts";
import type { PatcherSectionNoticeKey, RomInputRowState } from "./patcher-ui-state.ts";
import { useLatestRef } from "./use-latest-ref.ts";

const logger = createLogger("patcher-controllers");

type SessionState = ReturnType<typeof useLocalPatcherSessionState>;
type FailurePlacement = "input" | "output" | "patch" | null;

interface InputUiControllerContext {
  actions: Pick<
    SessionState,
    | "setErrorMessage"
    | "setOutputErrorMessage"
    | "setPatchProgress"
    | "setPatchProgressByKey"
    | "setPatchStaging"
    | "setProgress"
    | "setRomInputs"
  > & {
    clearDismissibleErrors: () => void;
    emitSessionTrace: (message: string, details?: Record<string, unknown>) => void;
    invalidatePatchStage: () => void;
    setChecksumOverrideChecked: Dispatch<SetStateAction<boolean>>;
    setFailurePlacement: Dispatch<SetStateAction<FailurePlacement>>;
    updateInputs: (nextInputs: BinarySource[]) => void;
    updatePatches: (nextPatches: BinarySource[]) => void;
    updateSettings: (nextSettings: ApplyPatchFormSettings) => void;
  };
  state: {
    activePatches: BinarySource[];
    activeSettings: ApplyPatchFormSettings;
    effectiveInputs: BinarySource[];
    failurePlacement: FailurePlacement;
    outputErrorMessage: string;
    romInputs: RomInputRowState[];
  };
}

// ROM-input + notice action handlers for the patcher UI store. Returned object is stable (handlers read
// the live context through a ref); the parent merges in the store's getState/subscribe.
const useInputUiController = (context: InputUiControllerContext) => {
  const contextRef = useLatestRef(context);
  return useMemo(
    () => ({
      clearRomInput: () => {
        const { actions, state } = contextRef.current;
        actions.emitSessionTrace("clearRomInput requested", {
          previousCount: state.effectiveInputs.length,
        });
        actions.updateInputs([]);
      },
      dismissNotice: (key: PatcherSectionNoticeKey) => {
        const { actions, state } = contextRef.current;
        if (key === "inputNotice" && state.failurePlacement === "input") {
          actions.setFailurePlacement(null);
          actions.setErrorMessage("");
          return;
        }
        if (key === "patchNotice" && state.failurePlacement === "patch") {
          actions.setFailurePlacement(null);
          actions.setErrorMessage("");
          return;
        }
        if (key === "outputNotice") {
          if (state.outputErrorMessage) actions.setOutputErrorMessage("");
          if (state.failurePlacement === "output") {
            actions.setFailurePlacement(null);
            actions.setErrorMessage("");
          }
        }
      },
      providePatchInputFiles: (fileList: FileList | BinarySource[] | null) => {
        const { actions, state } = contextRef.current;
        const providedPatches = Array.from(fileList || []) as BinarySource[];
        const nextPatches = providedPatches.length ? [...state.activePatches, ...providedPatches] : providedPatches;
        actions.emitSessionTrace("providePatchInputFiles requested", {
          existingCount: state.activePatches.length,
          nextCount: nextPatches.length,
          providedCount: providedPatches.length,
          providedSources: getTraceSourceSummaries(providedPatches, "Patch"),
        });
        actions.invalidatePatchStage();
        actions.setPatchProgress(null);
        actions.setPatchProgressByKey({});
        actions.setPatchStaging(false);
        actions.clearDismissibleErrors();
        actions.setProgress(null);
        actions.updatePatches(nextPatches);
      },
      provideRomInputFile: (file: BinarySource | null) => {
        const { actions, state } = contextRef.current;
        actions.emitSessionTrace("provideRomInputFile requested", {
          existingCount: state.effectiveInputs.length,
          hasFile: !!file,
          source: file ? getTraceSourceSummary(file, "Input") : undefined,
        });
        if (!file) {
          actions.updateInputs([]);
          return;
        }
        actions.updateInputs([...state.effectiveInputs, file]);
      },
      provideRomInputFiles: (fileList: FileList | BinarySource[] | null) => {
        const { actions, state } = contextRef.current;
        const providedInputs = Array.from(fileList || []) as BinarySource[];
        const nextInputs = [...state.effectiveInputs, ...providedInputs];
        actions.emitSessionTrace("provideRomInputFiles requested", {
          existingCount: state.effectiveInputs.length,
          nextCount: nextInputs.length,
          providedCount: providedInputs.length,
          providedSources: getTraceSourceSummaries(providedInputs, "Input"),
        });
        actions.updateInputs(nextInputs);
      },
      removeRomInput: (id: string) => {
        const { actions, state } = contextRef.current;
        const index = state.romInputs.findIndex((entry) => entry.id === id);
        if (index === -1) return;
        actions.emitSessionTrace("removeRomInput requested", {
          id,
          index,
          previousCount: state.effectiveInputs.length,
        });
        if (state.effectiveInputs.length === 1) actions.updateInputs([]);
        else actions.updateInputs(state.effectiveInputs.filter((_input, inputIndex) => inputIndex !== index));
      },
      setAlterHeader: (checked: boolean) => {
        const { actions, state } = contextRef.current;
        actions.updateSettings({
          ...state.activeSettings,
          compatibility: {
            ...state.activeSettings.compatibility,
            fixChecksum: checked,
          },
        });
      },
      setChecksumOverride: (checked: boolean) => {
        contextRef.current.actions.setChecksumOverrideChecked(checked);
      },
      toggleRomInputChecksums: (id: string) => {
        contextRef.current.actions.setRomInputs((current) =>
          current.map((entry) =>
            entry.id === id
              ? createRomInputRow({
                  ...entry,
                  info: { ...entry.info, checksumsExpanded: !entry.info.checksumsExpanded },
                })
              : entry,
          ),
        );
      },
    }),
    [contextRef],
  );
};

interface PatchStackControllerContext {
  actions: {
    createStageSnapshot: () => ApplyWorkflowStageSnapshot;
    getPatchKey: (source: BinarySource, sources?: BinarySource[]) => string;
    onError?: (error: Error) => void;
    setPatchInfoByKey: SessionState["setPatchInfoByKey"];
    setPatchOption?: LocalApplyPatchFormSessionOptions["setPatchOption"];
    setPatchTarget?: LocalApplyPatchFormSessionOptions["setPatchTarget"];
    setSectionErrorMessage: (placement: "input" | "output" | "patch", error: Error) => void;
    updatePatches: (nextPatches: BinarySource[]) => void;
  };
  state: {
    activePatches: BinarySource[];
  };
}

const applyPatchInfoUpdates = (
  setPatchInfoByKey: SessionState["setPatchInfoByKey"],
  getPatchKey: (source: BinarySource, sources?: BinarySource[]) => string,
  snapshot: ApplyWorkflowStageSnapshot,
  infos: Array<StagedInputInfo | null | undefined>,
) => {
  setPatchInfoByKey((current) => {
    const next = { ...current };
    for (const info of infos) {
      if (!info) continue;
      const patch = typeof info.order === "number" ? snapshot.patches[info.order] : undefined;
      const key = patch ? getPatchKey(patch, snapshot.patches) : info.id;
      if (key) next[key] = info;
    }
    return next;
  });
};

// Patch-stack action handlers (reorder, remove, per-patch option/target). Returned object is stable;
// the parent merges in the store's getState/subscribe.
const usePatchStackController = (context: PatchStackControllerContext) => {
  const contextRef = useLatestRef(context);
  return useMemo(
    () => ({
      removeItem: (index: number) => {
        const { actions, state } = contextRef.current;
        actions.updatePatches(state.activePatches.filter((_patch, patchIndex) => patchIndex !== index));
      },
      replaceItem: (index: number, source: BinarySource) => {
        const { actions, state } = contextRef.current;
        if (index < 0 || index >= state.activePatches.length) return;
        actions.updatePatches(state.activePatches.map((patch, patchIndex) => (patchIndex === index ? source : patch)));
      },
      reorder: (from: number, to: number) => {
        const { actions, state } = contextRef.current;
        const count = state.activePatches.length;
        if (from === to || from < 0 || from >= count || to < 0 || to >= count) return;
        logger.debug("patch reorder", { count, from, to });
        actions.updatePatches(reorder(state.activePatches, from, to));
      },
      setPatchOption: async (
        index: number,
        option: {
          validateInputChecksum?: string;
          validateOutputChecksum?: string;
          header?: "keep" | "strip";
          n64ByteOrder?: "keep" | "big-endian" | "little-endian" | "byte-swapped";
          revalidate?: boolean;
        },
      ) => {
        const { actions } = contextRef.current;
        if (!actions.setPatchOption) return;
        try {
          const snapshot = actions.createStageSnapshot();
          const infos = await actions.setPatchOption(snapshot, index, option);
          applyPatchInfoUpdates(actions.setPatchInfoByKey, actions.getPatchKey, snapshot, infos);
        } catch (error) {
          const normalizedError = toError(error);
          logUiError("Patch option update failed", normalizedError);
          actions.setSectionErrorMessage("patch", normalizedError);
          actions.onError?.(normalizedError);
        }
      },
      setPatchTarget: async (index: number, targetInputId: string) => {
        const { actions } = contextRef.current;
        if (!actions.setPatchTarget) return;
        try {
          const snapshot = actions.createStageSnapshot();
          const infos = await actions.setPatchTarget(snapshot, index, targetInputId);
          applyPatchInfoUpdates(actions.setPatchInfoByKey, actions.getPatchKey, snapshot, infos);
        } catch (error) {
          const normalizedError = toError(error);
          logUiError("Patch target selection failed", normalizedError);
          actions.setSectionErrorMessage("patch", normalizedError);
          actions.onError?.(normalizedError);
        }
      },
    }),
    [contextRef],
  );
};

export { useInputUiController, usePatchStackController };
