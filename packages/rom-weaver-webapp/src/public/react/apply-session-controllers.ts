import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PatcherOutputController, PatcherStackController } from "./patcher-form.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";

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

const inertStackController: PatcherStackController = {
  ...createStaticStoreController({ items: [] }),
  removeItem: () => undefined,
  replaceItem: () => undefined,
  reorder: () => undefined,
};
const inertOutputController: PatcherOutputController = {
  ...createStaticStoreController({
    applyButton: {
      disabled: true,
      label: "Apply patch",
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
  commitDisplayFileName: () => undefined,
  setOutputCompression: () => undefined,
  setOutputCompressOption: () => undefined,
  setOutputHeader: () => undefined,
};

export { inertOutputController, inertStackController, useLiveStoreController };
