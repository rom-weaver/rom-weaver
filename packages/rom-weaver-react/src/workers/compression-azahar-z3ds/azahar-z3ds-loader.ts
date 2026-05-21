/*
 * Runtime selector for RomWeaver Azahar Z3DS WebAssembly builds.
 */

import {
  createRuntimeLoaderModuleArg,
  createRuntimeSelectionRecord,
  getOrCreateRuntimeSelectionValue,
  getRuntimeSelectionKeyFromWorkerThreads,
  type RuntimeSelectionKey,
} from "../shared/wasm/runtime-selection.ts";
import type { WasmToolLoaderModuleArg, WasmToolLoaderModuleObject } from "../shared/wasm-loader-utils.ts";
import {
  createConfiguredWasmToolLoader,
  createThreadedWasmAssetResolver,
  getGlobalRoot,
  getStandardThreadedDisabledReason,
  normalizeWasmWorkerThreads,
} from "../shared/wasm-loader-utils.ts";

type LoaderFactoryModule = WasmToolLoaderModuleObject & {
  __azaharZ3dsSelectionReason?: string;
  __azaharZ3dsThreaded?: boolean;
  threadCount?: number;
};
type LoaderModuleArg = WasmToolLoaderModuleArg;

const root = getGlobalRoot();
const ASSET_NAMES = {
  singleJs: "azahar-z3ds.js",
  singleWasm: "azahar-z3ds.wasm",
  threadedJs: "azahar-z3ds-threaded.js",
  threadedWasm: "azahar-z3ds-threaded.wasm",
  threadedWorker: "azahar-z3ds-threaded.worker.js",
};

const azaharZ3dsModulePromises = createRuntimeSelectionRecord<Promise<LoaderFactoryModule> | null>(null);

const { moduleBaseUrl: BASE_URL, getAssetUrl: _getAssetUrl } = createThreadedWasmAssetResolver({
  assetNames: ASSET_NAMES,
  baseUrlGlobalProp: "__azaharZ3dsWasmBaseUrl",
  defaultBaseUrl: () => BASE_URL,
  moduleUrl: import.meta.url,
  root,
  vendorDirectory: "azahar-z3ds",
});

const _markSelection = (
  moduleObject: LoaderFactoryModule,
  threaded: boolean,
  reason: string,
  workerThreads: number | null,
) => {
  if (!moduleObject) return moduleObject;
  moduleObject.__azaharZ3dsThreaded = threaded === true;
  moduleObject.__azaharZ3dsSelectionReason = reason || (threaded ? "threaded" : "single");
  moduleObject.wasmToolName = moduleObject.wasmToolName || "azahar-z3ds";
  if (threaded) moduleObject.threadCount = Math.max(1, workerThreads || 8);
  else if (typeof moduleObject.threadCount !== "number") moduleObject.threadCount = 1;
  return moduleObject;
};

const _getSelectionReason = (moduleObject: LoaderFactoryModule) => {
  if (moduleObject.__azaharZ3dsThreaded === true && typeof moduleObject.__azaharZ3dsSelectionReason === "string")
    return moduleObject.__azaharZ3dsSelectionReason;
  return getStandardThreadedDisabledReason(root, { browserUnavailableReason: "single" });
};

const _getRuntimeSelectionKey = (moduleArg?: LoaderModuleArg): RuntimeSelectionKey =>
  getRuntimeSelectionKeyFromWorkerThreads(normalizeWasmWorkerThreads(moduleArg || null));

const _createLoaderModuleArg = (moduleArg: LoaderModuleArg, selectionKey: RuntimeSelectionKey): LoaderModuleArg =>
  createRuntimeLoaderModuleArg(moduleArg, selectionKey);

const loadAzaharZ3ds = (moduleArg?: LoaderModuleArg): Promise<LoaderFactoryModule> => {
  const selectionKey = _getRuntimeSelectionKey(moduleArg);
  const requestedWorkerThreads = normalizeWasmWorkerThreads(moduleArg || null);
  const modulePromise = getOrCreateRuntimeSelectionValue(azaharZ3dsModulePromises, selectionKey, () => {
    const activeModuleArg = _createLoaderModuleArg(moduleArg || {}, selectionKey);
    return createConfiguredWasmToolLoader<LoaderModuleArg, LoaderFactoryModule>({
      assetNames: ASSET_NAMES,
      createModuleObject: () => ({}) as LoaderFactoryModule,
      failureMessage: "azahar-z3ds wasm factory was not loaded",
      finalizeModule: (moduleObject, threaded, reason, _moduleArg, workerThreads) =>
        _markSelection(moduleObject, threaded, reason, workerThreads),
      getAssetUrl: _getAssetUrl,
      moduleArg: activeModuleArg,
      root,
      threadedWasmAliases: [ASSET_NAMES.singleWasm],
      warningMessage: "RomWeaver: threaded Azahar Z3DS failed to load, using single-threaded Z3DS.",
    }).then((moduleObject) =>
      _markSelection(
        moduleObject as LoaderFactoryModule,
        (moduleObject as LoaderFactoryModule).__azaharZ3dsThreaded === true,
        _getSelectionReason(moduleObject as LoaderFactoryModule),
        normalizeWasmWorkerThreads(activeModuleArg),
      ),
    );
  });
  return modulePromise.then((moduleObject) =>
    _markSelection(
      moduleObject as LoaderFactoryModule,
      (moduleObject as LoaderFactoryModule).__azaharZ3dsThreaded === true,
      _getSelectionReason(moduleObject as LoaderFactoryModule),
      requestedWorkerThreads,
    ),
  );
};

export default loadAzaharZ3ds;
