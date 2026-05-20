import type { EmscriptenWorkerModule } from "../shared/wasm/emscripten-types.ts";
import { waitForRuntimeInitialized } from "../shared/wasm/runtime-ready.ts";
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
import { workerScope } from "../shared/worker-compression-types.ts";
import loadDolphinRvz from "./dolphin-rvz-loader.ts";

const dolphinRvzReadyPromises = createRuntimeSelectionRecord<Promise<EmscriptenWorkerModule> | null>(null);
const dolphinRvzModules = createRuntimeSelectionRecord<EmscriptenWorkerModule | null>(null);
const dolphinRvzScriptsLoaded = createRuntimeSelectionRecord(false);

const getRuntimeSelectionKey = (threads: ThreadInput): RuntimeSelectionKey =>
  getRuntimeSelectionKeyFromWorkerThreads(normalizeWorkerThreadCount(threads));

const configureDolphinRvzThreadCount = (moduleObject: EmscriptenWorkerModule, threads: ThreadInput) => {
  const normalizedThreads = normalizeWorkerThreadCount(threads);
  if (normalizedThreads === null || normalizedThreads === 0) return moduleObject;
  if (moduleObject.dolphinRvz?.threaded) moduleObject.dolphinRvz.threadCount = normalizedThreads;
  return moduleObject;
};

const loadDolphinRvzScripts = (threads: ThreadInput) => {
  const selectionKey = getRuntimeSelectionKey(threads);
  if (dolphinRvzScriptsLoaded[selectionKey]) {
    if (dolphinRvzModules[selectionKey])
      return Promise.resolve(configureDolphinRvzThreadCount(dolphinRvzModules[selectionKey], threads));
    return Promise.reject(new Error("RVZ tools did not finish loading."));
  }
  workerScope.Module = createLoaderThreadOptions(threads);
  dolphinRvzScriptsLoaded[selectionKey] = true;
  return loadDolphinRvz(workerScope.Module).then((moduleObject) => {
    const nextModule = configureDolphinRvzThreadCount(moduleObject as EmscriptenWorkerModule, threads);
    dolphinRvzModules[selectionKey] = nextModule;
    workerScope.Module = nextModule;
    return nextModule;
  });
};

const waitForDolphinRvzModule = (threads: ThreadInput) => {
  const selectionKey = getRuntimeSelectionKey(threads);
  const readyPromise = getOrCreateRuntimeSelectionValue(dolphinRvzReadyPromises, selectionKey, () =>
    Promise.resolve()
      .then(() => loadDolphinRvzScripts(threads))
      .then((moduleObject) => waitForRuntimeInitialized(moduleObject, (nextModule) => !!nextModule?.dolphinRvz)),
  );
  return readyPromise.then((moduleObject) => configureDolphinRvzThreadCount(moduleObject, threads));
};

export { configureDolphinRvzThreadCount, loadDolphinRvzScripts, waitForDolphinRvzModule };
