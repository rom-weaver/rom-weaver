/*
 * Runtime selector for Dolphin RVZ WebAssembly builds.
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
  installDeferredModuleMutation,
  normalizeWasmWorkerThreads,
} from "../shared/wasm-loader-utils.ts";

type LoaderModuleArg = WasmToolLoaderModuleArg;

type DolphinRvzRuntimeState = {
  __romWeaverWasmAbort?: RuntimeValue | null;
  threaded?: boolean;
  threadCount?: number;
  selectionReason?: string;
  wasmToolName?: string;
};

type LoaderModuleObject = WasmToolLoaderModuleObject & {
  __dolphinRvzSelectionReason?: string;
  __dolphinRvzThreaded?: boolean;
  dolphinRvz?: DolphinRvzRuntimeState;
};

const root = getGlobalRoot();
const ASSET_NAMES = {
  singleJs: "dolphin-rvz.js",
  singleWasm: "dolphin-rvz.wasm",
  threadedJs: "dolphin-rvz-threaded.js",
  threadedWasm: "dolphin-rvz-threaded.wasm",
  threadedWorker: "dolphin-rvz-threaded.worker.js",
};
const dolphinRvzModulePromises = createRuntimeSelectionRecord<Promise<LoaderModuleObject> | null>(null);

const { moduleBaseUrl: DEFAULT_BASE_URL, getAssetUrl: _getAssetUrl } = createThreadedWasmAssetResolver({
  assetNames: ASSET_NAMES,
  baseUrlGlobalProp: "__dolphinRvzWasmBaseUrl",
  defaultBaseUrl: () => DEFAULT_BASE_URL,
  moduleUrl: import.meta.url,
  root,
  vendorDirectory: "dolphin-rvz",
});

const _markSelection = (
  moduleObject: LoaderModuleObject,
  threaded: boolean,
  reason: string,
  workerThreads: number | null,
) => {
  if (!moduleObject) return moduleObject;
  const selectedThreaded = threaded === true;
  const selectionReason = reason || (threaded ? "threaded" : "fallback");
  moduleObject.__dolphinRvzThreaded = selectedThreaded;
  moduleObject.__dolphinRvzSelectionReason = selectionReason;
  if (moduleObject.dolphinRvz) {
    moduleObject.dolphinRvz.__romWeaverWasmAbort = moduleObject.__romWeaverWasmAbort || null;
    moduleObject.dolphinRvz.wasmToolName = "dolphin-rvz";
    moduleObject.dolphinRvz.threaded = selectedThreaded;
    if (selectedThreaded) moduleObject.dolphinRvz.threadCount = Math.max(1, workerThreads || 8);
    else if (typeof moduleObject.dolphinRvz.threadCount !== "number") moduleObject.dolphinRvz.threadCount = 1;
    moduleObject.dolphinRvz.selectionReason = selectionReason;
  }
  return moduleObject;
};

const _installSelectionHook = (
  moduleObject: LoaderModuleObject,
  threaded: boolean,
  reason: string,
  workerThreads: number | null,
) => {
  return installDeferredModuleMutation(
    moduleObject,
    (activeModuleObject) => !!activeModuleObject.dolphinRvz,
    (activeModuleObject) => _markSelection(activeModuleObject, threaded, reason, workerThreads),
  );
};

const _getSelectionReason = (moduleObject: LoaderModuleObject) => {
  if (moduleObject.__dolphinRvzThreaded === true && typeof moduleObject.__dolphinRvzSelectionReason === "string")
    return moduleObject.__dolphinRvzSelectionReason;
  return getStandardThreadedDisabledReason(root);
};

const _getRuntimeSelectionKey = (moduleArg?: LoaderModuleArg): RuntimeSelectionKey =>
  getRuntimeSelectionKeyFromWorkerThreads(normalizeWasmWorkerThreads(moduleArg || null));

const _createLoaderModuleArg = (moduleArg: LoaderModuleArg, selectionKey: RuntimeSelectionKey): LoaderModuleArg =>
  createRuntimeLoaderModuleArg(moduleArg, selectionKey);

const loadDolphinRvz = (moduleArg?: LoaderModuleArg) => {
  if (moduleArg) root.Module = Object.assign(root.Module || {}, moduleArg);
  const selectionKey = _getRuntimeSelectionKey(moduleArg);
  const requestedWorkerThreads = normalizeWasmWorkerThreads(moduleArg || null);
  const modulePromise = getOrCreateRuntimeSelectionValue(dolphinRvzModulePromises, selectionKey, () => {
    const activeModuleArg = _createLoaderModuleArg(moduleArg || {}, selectionKey);
    return createConfiguredWasmToolLoader<LoaderModuleArg, LoaderModuleObject>({
      assetNames: ASSET_NAMES,
      createModuleObject: (loaderModuleArg) => ({ ...(loaderModuleArg || {}) }) as LoaderModuleObject,
      failureMessage: "dolphin-rvz wasm factory was not loaded",
      finalizeModule: (moduleObject, threaded, reason, _moduleArg, workerThreads) =>
        _installSelectionHook(
          _markSelection(moduleObject, threaded, reason, workerThreads),
          threaded,
          reason,
          workerThreads,
        ),
      getAssetUrl: _getAssetUrl,
      moduleArg: activeModuleArg,
      root,
      warningMessage: "Dolphin RVZ: threaded wasm failed to load, using fallback wasm.",
    }).then((moduleObject) =>
      _markSelection(
        moduleObject as LoaderModuleObject,
        (moduleObject as LoaderModuleObject).__dolphinRvzThreaded === true,
        _getSelectionReason(moduleObject as LoaderModuleObject),
        normalizeWasmWorkerThreads(activeModuleArg),
      ),
    );
  });
  return modulePromise.then((moduleObject) =>
    _markSelection(
      moduleObject as LoaderModuleObject,
      (moduleObject as LoaderModuleObject).__dolphinRvzThreaded === true,
      _getSelectionReason(moduleObject as LoaderModuleObject),
      requestedWorkerThreads,
    ),
  );
};

export default loadDolphinRvz;
