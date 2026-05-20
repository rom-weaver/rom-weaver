/*
 * Runtime selector for Rom Patcher JS chdman WebAssembly builds.
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
  getOrCreateModuleObject,
  getStandardThreadedDisabledReason,
  installDeferredModuleMutation,
  normalizeWasmWorkerThreads,
} from "../shared/wasm-loader-utils.ts";

type LoaderModuleArg = WasmToolLoaderModuleArg;

type EmscriptenFsLike = {
  getPath?: (node: RuntimeValue) => string;
  read?: (...args: RuntimeValue[]) => number;
  write?: (...args: RuntimeValue[]) => number;
};

type WasmToolRuntimeState = {
  __romWeaverWasmAbort?: RuntimeValue | null;
  FS?: EmscriptenFsLike;
  threaded?: boolean;
  threadCount?: number | undefined;
  selectionReason?: string;
  wasmToolName?: string;
};

type LoaderModuleObject = WasmToolLoaderModuleObject & {
  FS?: EmscriptenFsLike;
  wasmToolName?: string;
  wasmTool?: WasmToolRuntimeState;
  __wasmToolThreadCount?: string | number | null;
  __wasmToolThreaded?: boolean;
  __wasmToolSelectionReason?: string;
};

const root = getGlobalRoot();
const ASSET_NAMES = {
  singleJs: "chdman.js",
  singleWasm: "chdman.wasm",
  threadedJs: "chdman-threaded.js",
  threadedWasm: "chdman-threaded.wasm",
  threadedWorker: "chdman-threaded.worker.js",
};

const chdmanModulePromises = createRuntimeSelectionRecord<Promise<LoaderModuleObject> | null>(null);

const { moduleBaseUrl: BASE_URL, getAssetUrl: _getAssetUrl } = createThreadedWasmAssetResolver({
  assetNames: ASSET_NAMES,
  baseUrlGlobalProp: "__chdmanWasmBaseUrl",
  defaultBaseUrl: () => BASE_URL,
  moduleUrl: import.meta.url,
  root,
  vendorDirectory: "chdman",
});

const _getExplicitThreadCount = (moduleObject: LoaderModuleObject) => {
  const threadCount = moduleObject.__wasmToolThreadCount;
  if (typeof threadCount !== "number" || !Number.isFinite(threadCount) || threadCount <= 0) return null;
  return Math.max(1, Math.min(64, Math.floor(threadCount)));
};

const _markSelection = (
  moduleObject: LoaderModuleObject,
  threaded: boolean,
  reason: string,
  workerThreads: number | null,
) => {
  if (!moduleObject) return moduleObject;
  moduleObject.wasmToolName = moduleObject.wasmToolName || "chdman";
  const selectedThreaded = threaded === true;
  moduleObject.__wasmToolThreaded = selectedThreaded;
  moduleObject.__wasmToolSelectionReason = reason || (threaded ? "threaded" : "single");
  const wasmTool = moduleObject.wasmTool;
  if (wasmTool) {
    wasmTool.__romWeaverWasmAbort = moduleObject.__romWeaverWasmAbort || null;
    if (moduleObject.FS) wasmTool.FS = moduleObject.FS;
    wasmTool.wasmToolName = moduleObject.wasmToolName || "chdman";
    wasmTool.threaded = selectedThreaded;
    if (selectedThreaded) {
      const explicitThreadCount = _getExplicitThreadCount(moduleObject);
      const fallbackThreadCount =
        typeof workerThreads === "number" && Number.isFinite(workerThreads) && workerThreads > 0
          ? Math.max(1, Math.min(64, Math.floor(workerThreads)))
          : null;
      if (explicitThreadCount) wasmTool.threadCount = explicitThreadCount;
      else if (fallbackThreadCount) wasmTool.threadCount = fallbackThreadCount;
      else if (typeof wasmTool.threadCount !== "number" || wasmTool.threadCount <= 1) delete wasmTool.threadCount;
    } else if (typeof wasmTool.threadCount !== "number") wasmTool.threadCount = 1;
    wasmTool.selectionReason = moduleObject.__wasmToolSelectionReason;
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
    (activeModuleObject) => !!activeModuleObject.wasmTool,
    (activeModuleObject) => _markSelection(activeModuleObject, threaded, reason, workerThreads),
  );
};

const _prepareModuleObject = (moduleObject: LoaderModuleObject) => {
  moduleObject.wasmToolName = moduleObject.wasmToolName || "chdman";
  return moduleObject;
};

const _getSelectionReason = (moduleObject: LoaderModuleObject) => {
  if (moduleObject.__wasmToolThreaded === true && typeof moduleObject.__wasmToolSelectionReason === "string")
    return moduleObject.__wasmToolSelectionReason;
  return getStandardThreadedDisabledReason(root, {
    browserDisabledReason: "browser-threaded-missing",
    browserUnavailableReason: "single",
  });
};

const _getRuntimeSelectionKey = (moduleArg?: LoaderModuleArg): RuntimeSelectionKey =>
  getRuntimeSelectionKeyFromWorkerThreads(normalizeWasmWorkerThreads(moduleArg || null));

const _createLoaderModuleArg = (moduleArg: LoaderModuleArg, selectionKey: RuntimeSelectionKey): LoaderModuleArg =>
  createRuntimeLoaderModuleArg(moduleArg, selectionKey);

const loadChdman = (moduleArg?: LoaderModuleArg) => {
  if (moduleArg) root.Module = Object.assign(root.Module || {}, moduleArg);
  const selectionKey = _getRuntimeSelectionKey(moduleArg);
  const requestedWorkerThreads = normalizeWasmWorkerThreads(moduleArg || null);
  const modulePromise = getOrCreateRuntimeSelectionValue(chdmanModulePromises, selectionKey, () => {
    const activeModuleArg = _createLoaderModuleArg(moduleArg || {}, selectionKey);
    return createConfiguredWasmToolLoader<LoaderModuleArg, LoaderModuleObject>({
      assetNames: ASSET_NAMES,
      createModuleObject: (loaderModuleArg) =>
        Object.assign(getOrCreateModuleObject(root), loaderModuleArg || {}) as LoaderModuleObject,
      failureMessage: "chdman wasm factory was not loaded",
      finalizeModule: (moduleObject, threaded, reason, _moduleArg, workerThreads) =>
        _installSelectionHook(
          _markSelection(moduleObject, threaded, reason, workerThreads),
          threaded,
          reason,
          workerThreads,
        ),
      getAssetUrl: _getAssetUrl,
      moduleArg: activeModuleArg,
      prepareModuleObject: (moduleObject) => _prepareModuleObject(moduleObject),
      root,
      warningMessage: "Rom Patcher JS: threaded chdman failed to load, using single-threaded chdman.",
    }).then((moduleObject) =>
      _markSelection(
        moduleObject as LoaderModuleObject,
        (moduleObject as LoaderModuleObject).__wasmToolThreaded === true,
        _getSelectionReason(moduleObject as LoaderModuleObject),
        normalizeWasmWorkerThreads(activeModuleArg),
      ),
    );
  });
  return modulePromise.then((moduleObject) =>
    _markSelection(
      moduleObject as LoaderModuleObject,
      (moduleObject as LoaderModuleObject).__wasmToolThreaded === true,
      _getSelectionReason(moduleObject as LoaderModuleObject),
      requestedWorkerThreads,
    ),
  );
};

export default loadChdman;
