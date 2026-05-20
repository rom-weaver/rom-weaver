/*
 * Runtime loader for the Rom Patcher JS xdelta3 WebAssembly build.
 */

import type { WasmToolLoaderModuleArg, WasmToolLoaderModuleObject } from "../../../shared/wasm-loader-utils.ts";
import {
  createAssetUrlResolver,
  getGlobalRoot,
  importExternalModule,
  installWasmAbortCapture,
} from "../../../shared/wasm-loader-utils.ts";
import { assertNotXdeltaBrowserMainThread } from "./xdelta-runtime.ts";

type LoaderModuleArg = WasmToolLoaderModuleArg;

type LoaderModuleObject = WasmToolLoaderModuleObject & {
  __xdelta3SelectionReason?: string;
  __xdelta3Threaded?: boolean;
};

const root = getGlobalRoot();
const ASSET_NAMES = {
  js: "xdelta3.js",
  wasm: "xdelta3.wasm",
};
const TRAILING_PATH_SEGMENT_REGEX = /[^/]*$/;

type Xdelta3Factory = (moduleObject: LoaderModuleObject) => Promise<LoaderModuleObject> | LoaderModuleObject;

const getModuleBaseUrl = () => {
  const moduleUrl = new URL(import.meta.url);
  const pathName = moduleUrl.pathname;
  moduleUrl.hash = "";
  moduleUrl.search = "";
  moduleUrl.pathname = pathName.replace(TRAILING_PATH_SEGMENT_REGEX, "");
  return moduleUrl.href;
};

const MODULE_BASE_URL = getModuleBaseUrl();
const MODULE_PATHNAME = new URL(import.meta.url).pathname;
const USE_SOURCE_VENDOR_ASSETS =
  MODULE_PATHNAME.indexOf("/src/workers/shared/") !== -1 ||
  MODULE_PATHNAME.indexOf("/src/workers/patch-checksum/") !== -1 ||
  MODULE_PATHNAME.indexOf("/src/workers/compression-") !== -1;
const USE_BUNDLED_NODE_ASSETS = false;

const _getSourceVendorAssetUrl = (assetName: string) => {
  const sourceModuleUrl = new URL(import.meta.url);
  const sourceRootIndex = sourceModuleUrl.pathname.indexOf("/src/");
  if (sourceRootIndex !== -1) {
    sourceModuleUrl.pathname = `${sourceModuleUrl.pathname.slice(0, sourceRootIndex)}/vendor/wasm/xdelta3/${assetName}`;
    sourceModuleUrl.hash = "";
    return sourceModuleUrl.href;
  }
  return new URL(`../../../../../vendor/wasm/xdelta3/${assetName}`, import.meta.url).href;
};

const sourceAssetUrls = USE_SOURCE_VENDOR_ASSETS
  ? {
      [ASSET_NAMES.js]: _getSourceVendorAssetUrl(ASSET_NAMES.js),
      [ASSET_NAMES.wasm]: _getSourceVendorAssetUrl(ASSET_NAMES.wasm),
    }
  : null;

const { getAssetUrl: _getAssetUrl } = createAssetUrlResolver({
  assetUrls: USE_BUNDLED_NODE_ASSETS ? null : sourceAssetUrls,
  baseUrlGlobalProp: "__xdelta3WasmBaseUrl",
  defaultBaseUrl: () => MODULE_BASE_URL,
  root,
});

let factoryPromise: Promise<Xdelta3Factory> | null = null;

const _getFactory = () => {
  if (!factoryPromise) {
    factoryPromise = importExternalModule<{ default?: Xdelta3Factory }>(_getAssetUrl(ASSET_NAMES.js)).then(
      (namespace) => {
        if (typeof namespace.default !== "function") throw new Error("xdelta3 wasm factory was not loaded");
        return namespace.default;
      },
    );
  }
  return factoryPromise;
};

const _configureModuleObject = (moduleArg: LoaderModuleArg): LoaderModuleObject => {
  const moduleObject = (moduleArg || {}) as LoaderModuleObject;
  installWasmAbortCapture(moduleObject);
  moduleObject.noInitialRun = true;
  const previousLocateFile = moduleObject.locateFile;
  moduleObject.locateFile = (path, scriptDirectory) => {
    if (path === ASSET_NAMES.wasm) return _getAssetUrl(ASSET_NAMES.wasm);
    if (typeof previousLocateFile === "function") return previousLocateFile(path, scriptDirectory);
    return (scriptDirectory || "") + path;
  };
  return moduleObject;
};

const _markSelection = (moduleObject: LoaderModuleObject) => {
  if (!moduleObject) return moduleObject;
  moduleObject.__xdelta3Threaded = false;
  moduleObject.__xdelta3SelectionReason = "single-threaded";
  moduleObject.wasmToolName = moduleObject.wasmToolName || "xdelta3";
  return moduleObject;
};

const xdelta3Loader = (moduleArg?: LoaderModuleArg) => {
  assertNotXdeltaBrowserMainThread(root);
  return _getFactory().then((factory) =>
    Promise.resolve(factory(_configureModuleObject(moduleArg || {}))).then(_markSelection),
  );
};

export default Object.assign(xdelta3Loader, {
  canUseThreaded: () => false,
});
