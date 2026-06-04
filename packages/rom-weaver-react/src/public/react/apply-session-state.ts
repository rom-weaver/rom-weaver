import { type SetStateAction, useCallback, useReducer } from "react";
import type {
  LocalPatcherSessionState,
  LocalPatcherSessionStatePatch,
  StagedInputInfo,
} from "./apply-session-types.ts";
import { resolveLocalStateUpdate } from "./patcher-form-session-utils.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";
import type { InputProgress, RomInputRowState } from "./patcher-ui-state.ts";

const createLocalPatcherSessionState = (): LocalPatcherSessionState => ({
  busy: false,
  completedApplyTimeMs: null,
  completedCompressionTimeMs: null,
  completedSizeSummary: createOutputSizeSummary(),
  failureMessage: "",
  inputStaging: false,
  outputErrorMessage: "",
  outputName: "",
  outputNameEdited: false,
  patchInfoByKey: {},
  patchProgress: null,
  patchProgressByKey: {},
  patchStaging: false,
  pendingDownloadFileName: null,
  progress: null,
  romInputs: [],
});

const localPatcherSessionStateReducer = (
  state: LocalPatcherSessionState,
  patch: LocalPatcherSessionStatePatch,
): LocalPatcherSessionState => ({
  ...state,
  ...(typeof patch === "function" ? patch(state) : patch),
});

const useLocalPatcherSessionState = () => {
  const [localState, setLocalState] = useReducer(
    localPatcherSessionStateReducer,
    undefined,
    createLocalPatcherSessionState,
  );
  const setBusy = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({ busy: resolveLocalStateUpdate(current.busy, value) })),
    [],
  );
  const setInputStaging = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({ inputStaging: resolveLocalStateUpdate(current.inputStaging, value) })),
    [],
  );
  const setErrorMessage = useCallback(
    (value: SetStateAction<string>) =>
      setLocalState((current) => ({ failureMessage: resolveLocalStateUpdate(current.failureMessage, value) })),
    [],
  );
  const setOutputErrorMessage = useCallback(
    (value: SetStateAction<string>) =>
      setLocalState((current) => ({
        outputErrorMessage: resolveLocalStateUpdate(current.outputErrorMessage, value),
      })),
    [],
  );
  const setProgress = useCallback(
    (value: SetStateAction<InputProgress | null>) =>
      setLocalState((current) => ({ progress: resolveLocalStateUpdate(current.progress, value) })),
    [],
  );
  const setPatchProgress = useCallback(
    (value: SetStateAction<InputProgress | null>) =>
      setLocalState((current) => ({ patchProgress: resolveLocalStateUpdate(current.patchProgress, value) })),
    [],
  );
  const setPatchProgressByKey = useCallback(
    (value: SetStateAction<Record<string, InputProgress>>) =>
      setLocalState((current) => ({
        patchProgressByKey: resolveLocalStateUpdate(current.patchProgressByKey, value),
      })),
    [],
  );
  const setPatchStaging = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({ patchStaging: resolveLocalStateUpdate(current.patchStaging, value) })),
    [],
  );
  const setPatchInfoByKey = useCallback(
    (value: SetStateAction<Record<string, StagedInputInfo>>) =>
      setLocalState((current) => ({ patchInfoByKey: resolveLocalStateUpdate(current.patchInfoByKey, value) })),
    [],
  );
  const setRomInputs = useCallback(
    (value: SetStateAction<RomInputRowState[]>) =>
      setLocalState((current) => ({ romInputs: resolveLocalStateUpdate(current.romInputs, value) })),
    [],
  );
  const setOutputName = useCallback(
    (value: SetStateAction<string>) =>
      setLocalState((current) => ({ outputName: resolveLocalStateUpdate(current.outputName, value) })),
    [],
  );
  const setOutputNameEdited = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({
        outputNameEdited: resolveLocalStateUpdate(current.outputNameEdited, value),
      })),
    [],
  );
  const setCompletedSizeSummary = useCallback(
    (value: SetStateAction<ReturnType<typeof createOutputSizeSummary>>) =>
      setLocalState((current) => ({
        completedSizeSummary: resolveLocalStateUpdate(current.completedSizeSummary, value),
      })),
    [],
  );
  const setCompletedApplyTimeMs = useCallback(
    (value: SetStateAction<number | null>) =>
      setLocalState((current) => ({
        completedApplyTimeMs: resolveLocalStateUpdate(current.completedApplyTimeMs, value),
      })),
    [],
  );
  const setCompletedCompressionTimeMs = useCallback(
    (value: SetStateAction<number | null>) =>
      setLocalState((current) => ({
        completedCompressionTimeMs: resolveLocalStateUpdate(current.completedCompressionTimeMs, value),
      })),
    [],
  );
  const setPendingDownloadFileName = useCallback(
    (value: SetStateAction<string | null>) =>
      setLocalState((current) => ({
        pendingDownloadFileName: resolveLocalStateUpdate(current.pendingDownloadFileName, value),
      })),
    [],
  );

  return {
    localState,
    setBusy,
    setCompletedApplyTimeMs,
    setCompletedCompressionTimeMs,
    setCompletedSizeSummary,
    setErrorMessage,
    setInputStaging,
    setOutputErrorMessage,
    setOutputName,
    setOutputNameEdited,
    setPatchInfoByKey,
    setPatchProgress,
    setPatchProgressByKey,
    setPatchStaging,
    setPendingDownloadFileName,
    setProgress,
    setRomInputs,
  };
};

export { createLocalPatcherSessionState, localPatcherSessionStateReducer, useLocalPatcherSessionState };
