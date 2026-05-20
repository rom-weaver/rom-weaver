import type { EmscriptenWorkerModule } from "../shared/wasm/emscripten-types.ts";
import {
  createRuntimeSelectionRecord,
  getOrCreateRuntimeSelectionValue,
  getRuntimeSelectionKeyFromWorkerThreads,
  type RuntimeSelectionKey,
} from "../shared/wasm/runtime-selection.ts";
import {
  createLoaderThreadOptions,
  normalizeWorkerThreadCount,
  type ThreadInput,
} from "../shared/wasm/worker-thread-options.ts";
import loadAzaharZ3ds from "./azahar-z3ds-loader.ts";

const azaharZ3dsReadyPromises = createRuntimeSelectionRecord<Promise<EmscriptenWorkerModule> | null>(null);
const azaharZ3dsModules = createRuntimeSelectionRecord<EmscriptenWorkerModule | null>(null);
const azaharZ3dsScriptsLoaded = createRuntimeSelectionRecord(false);

const getRuntimeSelectionKey = (threads: ThreadInput): RuntimeSelectionKey =>
  getRuntimeSelectionKeyFromWorkerThreads(normalizeWorkerThreadCount(threads));

const configureAzaharZ3dsThreadCount = (moduleObject: EmscriptenWorkerModule, threads: ThreadInput) => {
  const normalizedThreads = normalizeWorkerThreadCount(threads);
  if (normalizedThreads === null || normalizedThreads === 0) return moduleObject;
  if (moduleObject.__azaharZ3dsThreaded === true) moduleObject.threadCount = normalizedThreads;
  return moduleObject;
};

const loadAzaharZ3dsScripts = (threads: ThreadInput) => {
  const selectionKey = getRuntimeSelectionKey(threads);
  if (azaharZ3dsScriptsLoaded[selectionKey]) {
    if (azaharZ3dsModules[selectionKey])
      return Promise.resolve(configureAzaharZ3dsThreadCount(azaharZ3dsModules[selectionKey], threads));
    return Promise.reject(new Error("Z3DS tools did not finish loading."));
  }
  azaharZ3dsScriptsLoaded[selectionKey] = true;
  return loadAzaharZ3ds(createLoaderThreadOptions(threads)).then((moduleObject) => {
    const nextModule = configureAzaharZ3dsThreadCount(moduleObject as EmscriptenWorkerModule, threads);
    azaharZ3dsModules[selectionKey] = nextModule;
    return nextModule;
  });
};

const waitForAzaharZ3dsModule = (threads: ThreadInput) => {
  const selectionKey = getRuntimeSelectionKey(threads);
  const readyPromise = getOrCreateRuntimeSelectionValue(azaharZ3dsReadyPromises, selectionKey, () =>
    Promise.resolve().then(() => loadAzaharZ3dsScripts(threads)),
  );
  return readyPromise.then((moduleObject) => configureAzaharZ3dsThreadCount(moduleObject, threads));
};

export { configureAzaharZ3dsThreadCount, loadAzaharZ3dsScripts, waitForAzaharZ3dsModule };
