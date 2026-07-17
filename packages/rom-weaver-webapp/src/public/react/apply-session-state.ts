import { type SetStateAction, useMemo, useReducer } from "react";
import type { LocalPatcherSessionState, LocalPatcherSessionStatePatch } from "./apply-session-types.ts";
import { resolveLocalStateUpdate } from "./patcher-form-session-utils.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";

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

const hasShallowEqualValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (
    !(left && right) ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value]) => Object.is(value, (right as Record<string, unknown>)[key]));
};

const localPatcherSessionStateReducer = (
  state: LocalPatcherSessionState,
  patch: LocalPatcherSessionStatePatch,
): LocalPatcherSessionState => {
  const resolvedPatch = typeof patch === "function" ? patch(state) : patch;
  if (
    Object.entries(resolvedPatch).every(([key, value]) =>
      hasShallowEqualValue(state[key as keyof LocalPatcherSessionState], value),
    )
  ) {
    return state;
  }
  return {
    ...state,
    ...resolvedPatch,
  };
};

type LocalSessionDispatch = (patch: LocalPatcherSessionStatePatch) => void;
type LocalSessionFieldSetter<K extends keyof LocalPatcherSessionState> = (
  value: SetStateAction<LocalPatcherSessionState[K]>,
) => void;

// Every session setter is "patch one field through resolveLocalStateUpdate"; build them from a
// single typed factory instead of hand-writing 16 identical useCallbacks. The factory closes over
// the (stable) reducer dispatch, so each setter keeps a stable identity for the hooks that depend
// on it. The computed-key object is widened to a string index, so the patch shape is asserted back.
const createFieldSetter =
  <K extends keyof LocalPatcherSessionState>(dispatch: LocalSessionDispatch, key: K): LocalSessionFieldSetter<K> =>
  (value) =>
    dispatch(
      (current) => ({ [key]: resolveLocalStateUpdate(current[key], value) }) as Partial<LocalPatcherSessionState>,
    );

const useLocalPatcherSessionState = () => {
  const [localState, setLocalState] = useReducer(
    localPatcherSessionStateReducer,
    undefined,
    createLocalPatcherSessionState,
  );
  // setLocalState is reducer-stable, so the setters are created once and stay referentially stable.
  const setters = useMemo(
    () => ({
      setBusy: createFieldSetter(setLocalState, "busy"),
      setCompletedApplyTimeMs: createFieldSetter(setLocalState, "completedApplyTimeMs"),
      setCompletedCompressionTimeMs: createFieldSetter(setLocalState, "completedCompressionTimeMs"),
      setCompletedSizeSummary: createFieldSetter(setLocalState, "completedSizeSummary"),
      setErrorMessage: createFieldSetter(setLocalState, "failureMessage"),
      setInputStaging: createFieldSetter(setLocalState, "inputStaging"),
      setOutputErrorMessage: createFieldSetter(setLocalState, "outputErrorMessage"),
      setOutputName: createFieldSetter(setLocalState, "outputName"),
      setOutputNameEdited: createFieldSetter(setLocalState, "outputNameEdited"),
      setPatchInfoByKey: createFieldSetter(setLocalState, "patchInfoByKey"),
      setPatchProgress: createFieldSetter(setLocalState, "patchProgress"),
      setPatchProgressByKey: createFieldSetter(setLocalState, "patchProgressByKey"),
      setPatchStaging: createFieldSetter(setLocalState, "patchStaging"),
      setPendingDownloadFileName: createFieldSetter(setLocalState, "pendingDownloadFileName"),
      setProgress: createFieldSetter(setLocalState, "progress"),
      setRomInputs: createFieldSetter(setLocalState, "romInputs"),
    }),
    [],
  );

  return { localState, ...setters };
};

export { createLocalPatcherSessionState, localPatcherSessionStateReducer, useLocalPatcherSessionState };
