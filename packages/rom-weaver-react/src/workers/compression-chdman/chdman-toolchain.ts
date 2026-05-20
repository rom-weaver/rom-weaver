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
import loadChdman from "./chdman-loader.ts";

const getSourceVendorWasmUrl = () => {
  const sourceModuleUrl = new URL(import.meta.url);
  const sourceRootIndex = sourceModuleUrl.pathname.indexOf("/src/");
  if (sourceRootIndex !== -1) {
    sourceModuleUrl.pathname = `${sourceModuleUrl.pathname.slice(0, sourceRootIndex)}/vendor/wasm/chdman/chdman.wasm`;
    sourceModuleUrl.hash = "";
    sourceModuleUrl.search = "";
    return sourceModuleUrl.href;
  }
  return new URL(/* @vite-ignore */ "./chdman.wasm", import.meta.url).href;
};

const CHDMAN_WASM_URL =
  typeof import.meta.env === "object"
    ? getSourceVendorWasmUrl()
    : new URL(/* @vite-ignore */ "./chdman.wasm", import.meta.url).href;

const chdmanReadyPromises = createRuntimeSelectionRecord<Promise<EmscriptenWorkerModule> | null>(null);
const chdModules = createRuntimeSelectionRecord<EmscriptenWorkerModule | null>(null);
const chdmanScriptsLoaded = createRuntimeSelectionRecord(false);

const getRuntimeSelectionKey = (threads: ThreadInput): RuntimeSelectionKey =>
  getRuntimeSelectionKeyFromWorkerThreads(normalizeWorkerThreadCount(threads));

const configureChdmanThreadCount = (moduleObject: EmscriptenWorkerModule, threads: ThreadInput) => {
  const normalizedThreads = normalizeWorkerThreadCount(threads);
  if (normalizedThreads === null) return moduleObject;
  if (normalizedThreads === 0) {
    delete moduleObject.__wasmToolThreadCount;
    return moduleObject;
  }
  moduleObject.__wasmToolThreadCount = normalizedThreads;
  if (moduleObject.wasmTool?.threaded) moduleObject.wasmTool.threadCount = normalizedThreads;
  return moduleObject;
};

const loadChdmanScripts = (threads: ThreadInput) => {
  const selectionKey = getRuntimeSelectionKey(threads);
  if (chdmanScriptsLoaded[selectionKey]) {
    if (chdModules[selectionKey]) return Promise.resolve(configureChdmanThreadCount(chdModules[selectionKey], threads));
    return Promise.reject(new Error("CHD tools did not finish loading."));
  }
  workerScope.Module = configureChdmanThreadCount(
    {
      locateFile: (path: string, scriptDirectory?: string) => {
        if (path === "chdman.wasm") return CHDMAN_WASM_URL;
        return (scriptDirectory || "") + path;
      },
      ...createLoaderThreadOptions(threads),
      wasmToolName: "chdman",
    },
    threads,
  );
  chdmanScriptsLoaded[selectionKey] = true;
  return loadChdman(workerScope.Module).then((moduleObject) => {
    const nextModule = configureChdmanThreadCount(moduleObject as EmscriptenWorkerModule, threads);
    chdModules[selectionKey] = nextModule;
    workerScope.Module = nextModule;
    return nextModule;
  });
};

const waitForChdmanModule = (threads: ThreadInput) => {
  const selectionKey = getRuntimeSelectionKey(threads);
  const readyPromise = getOrCreateRuntimeSelectionValue(chdmanReadyPromises, selectionKey, () =>
    Promise.resolve()
      .then(() => loadChdmanScripts(threads))
      .then((moduleObject) => waitForRuntimeInitialized(moduleObject, (nextModule) => !!nextModule?.wasmTool)),
  );
  return readyPromise.then((moduleObject) => configureChdmanThreadCount(moduleObject, threads));
};

export { configureChdmanThreadCount, loadChdmanScripts, waitForChdmanModule };
