import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  DialogController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
} from "./patcher-form.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";
import { createInertPatcherUiSessionState, type PatcherUiSessionState } from "./patcher-ui-state.ts";

const createInertState = (): PatcherUiSessionState => createInertPatcherUiSessionState();
const createStaticStoreController = <State>(state: State) => ({
  getState: () => state,
  subscribe: () => () => undefined,
});
const useLiveStoreController = <State>(state: State) => {
  const stateRef = useRef(state);
  const listenersRef = useRef(new Set<() => void>());

  stateRef.current = state;

  useEffect(() => {
    stateRef.current = state;
    for (const listener of listenersRef.current) listener();
  }, [state]);

  const getState = useCallback(() => stateRef.current, []);
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return useMemo(() => ({ getState, subscribe }), [getState, subscribe]);
};

const inertState = createInertState();

const inertUiController: PatcherUiController = createStaticStoreController(inertState);
const inertDialogController: DialogController = createStaticStoreController(inertState);
const inertStackController: PatcherStackController = {
  ...createStaticStoreController({ items: [] }),
  removeItem: () => undefined,
  reorder: () => undefined,
};
const inertOutputController: PatcherOutputController = {
  ...createStaticStoreController({
    applyButton: {
      disabled: true,
      label: "Weave patch",
      loading: false,
      progress: null,
      title: "",
    },
    applyTiming: "",
    compress: null,
    compressionFormat: "zip",
    compressTiming: "",
    disabled: true,
    displayFileName: "",
    downloadSummary: null,
    options: [],
    pendingDownloadFileName: null,
    resolvedOutputName: "",
    sizeSummary: createOutputSizeSummary(),
    totalTiming: "",
  }),
  cancelPrimaryAction: () => undefined,
  runPrimaryAction: () => undefined,
  setDisplayFileName: () => undefined,
  setOutputCompression: () => undefined,
  setOutputCompressOption: () => undefined,
  setOutputHeader: () => undefined,
};

export {
  createInertState,
  inertDialogController,
  inertOutputController,
  inertStackController,
  inertUiController,
  useLiveStoreController,
};
