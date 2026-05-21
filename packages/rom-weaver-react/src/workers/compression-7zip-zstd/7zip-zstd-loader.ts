/*
 * Runtime selector for RomWeaver 7-Zip-zstd WebAssembly builds.
 */

import type { WasmToolLoaderModuleArg, WasmToolLoaderModuleObject } from "../shared/wasm-loader-utils.ts";
import {
  createConfiguredWasmToolLoader,
  createThreadedWasmAssetResolver,
  getGlobalRoot,
} from "../shared/wasm-loader-utils.ts";

type LoaderModuleArg = WasmToolLoaderModuleArg;

type LoaderModuleObject = WasmToolLoaderModuleObject & {
  __romWeaverSevenZipZstdSelectionReason?: string;
  __romWeaverSevenZipZstdThreadCount?: number;
  __romWeaverSevenZipZstdThreaded?: boolean;
};

const root = getGlobalRoot();
const ASSET_NAMES = {
  singleJs: "7zz.js",
  singleWasm: "7zz.wasm",
  threadedJs: "7zz-threaded.js",
  threadedWasm: "7zz-threaded.wasm",
};

const { moduleBaseUrl: scriptDirectory, getAssetUrl: _getAssetUrl } = createThreadedWasmAssetResolver({
  assetNames: ASSET_NAMES,
  baseUrlGlobalProp: "__romWeaverSevenZipZstdWasmBaseUrl",
  defaultBaseUrl: () => scriptDirectory,
  moduleUrl: import.meta.url,
  root,
  vendorDirectory: "7zip-zstd",
});

const _markSelection = (
  moduleObject: LoaderModuleObject,
  threaded: boolean,
  reason: string,
  workerThreads: number | null,
) => {
  if (!moduleObject) return moduleObject;
  moduleObject.__romWeaverSevenZipZstdThreaded = threaded === true;
  moduleObject.__romWeaverSevenZipZstdSelectionReason = reason || (threaded ? "threaded" : "fallback");
  moduleObject.__romWeaverSevenZipZstdThreadCount = threaded ? Math.max(2, workerThreads || 8) : 1;
  moduleObject.wasmToolName = moduleObject.wasmToolName || "7-Zip-zstd";
  moduleObject.threaded = moduleObject.__romWeaverSevenZipZstdThreaded;
  moduleObject.threadCount = moduleObject.__romWeaverSevenZipZstdThreadCount;
  moduleObject.selectionReason = moduleObject.__romWeaverSevenZipZstdSelectionReason;
  return moduleObject;
};

const sevenZipZstdLoader = (moduleArg?: LoaderModuleArg) => {
  return createConfiguredWasmToolLoader({
    assetNames: ASSET_NAMES,
    createModuleObject: (activeModuleArg) => (activeModuleArg || {}) as LoaderModuleObject,
    failureMessage: "7-Zip-zstd wasm factory was not loaded",
    finalizeModule: (moduleObject, threaded, reason, _moduleArg, workerThreads) =>
      _markSelection(moduleObject, threaded, reason, workerThreads),
    getAssetUrl: _getAssetUrl,
    moduleArg,
    noInitialRun: true,
    root,
    warningMessage: "RomWeaver: threaded 7-Zip-zstd failed to load, using fallback 7-Zip-zstd.",
  });
};

export default sevenZipZstdLoader;
