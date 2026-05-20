type RuntimeSelectionKey = "auto" | "single";

type LoaderModuleArgWithThreads = {
  workerThreads?: number | string | null;
};

const getRuntimeSelectionKeyFromWorkerThreads = (workerThreads: number | null | undefined): RuntimeSelectionKey =>
  workerThreads === 0 ? "single" : "auto";

const createRuntimeSelectionRecord = <T>(value: T): Record<RuntimeSelectionKey, T> => ({
  auto: value,
  single: value,
});

const getOrCreateRuntimeSelectionValue = <T>(
  selections: Record<RuntimeSelectionKey, T | null>,
  selectionKey: RuntimeSelectionKey,
  createValue: () => T,
): T => {
  const cachedValue = selections[selectionKey];
  if (cachedValue !== null) return cachedValue;
  const nextValue = createValue();
  selections[selectionKey] = nextValue;
  return nextValue;
};

const createRuntimeLoaderModuleArg = <T extends LoaderModuleArgWithThreads>(
  moduleArg: T,
  selectionKey: RuntimeSelectionKey,
): T => (selectionKey === "single" ? ({ ...(moduleArg || {}), workerThreads: 0 } as T) : moduleArg);

export type { RuntimeSelectionKey };
export {
  createRuntimeLoaderModuleArg,
  createRuntimeSelectionRecord,
  getOrCreateRuntimeSelectionValue,
  getRuntimeSelectionKeyFromWorkerThreads,
};
