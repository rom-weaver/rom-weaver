import { stampWorkerTransportMessage } from "./worker-message-utils.ts";

const PATH_DIRECTORY_PREFIX_REGEX = /^.*[/\\]/;
const WORKER_SCRIPT_EXTENSION_REGEX = /\.worker\.js$/;
const VITE_TIMESTAMP_QUERY_REGEX = /^\?t=\d+(?:&|$)/;

type RuntimeCallbackArgument = string | number | boolean | object | null | undefined;
type RuntimeErrorLike = Error | string | object | null | undefined;

type RuntimeRoot = typeof globalThis & {
  __azaharZ3dsWasmBaseUrl?: string;
  __chdmanWasmBaseUrl?: string;
  Module?: EmscriptenModuleObject;
  crossOriginIsolated?: boolean;
  name?: string;
  __dolphinRvzWasmBaseUrl?: string;
  __romWeaverSevenZipZstdWasmBaseUrl?: string;
  WorkerGlobalScope?: {
    prototype: WorkerGlobalScope;
    new (): WorkerGlobalScope;
  };
  __xdelta3WasmBaseUrl?: string;
};

type EmscriptenModuleObject = {
  __romWeaverWasmAbort?: {
    args: RuntimeCallbackArgument[];
    message: string;
    timestamp: number;
  } | null;
  locateFile?: (path: string, scriptDirectory: string) => string;
  mainScriptUrlOrBlob?: string;
  noInitialRun?: boolean;
  onAbort?: (...args: RuntimeCallbackArgument[]) => void;
  onRuntimeInitialized?: (...args: RuntimeCallbackArgument[]) => void;
};

type WasmToolLoaderModuleArg = {
  [key: string]: RuntimeCallbackArgument;
  workerThreads?: number | string | null;
};

type WasmToolLoaderModuleObject = EmscriptenModuleObject & {
  [key: string]: RuntimeCallbackArgument;
};

type AssetUrlResolverOptions = {
  root?: RuntimeRoot | null;
  assetUrls?: Record<string, string> | null;
  defaultBaseUrl?: string | (() => string);
  baseUrlGlobalProp?: string;
};

type ThreadedAssetNames = {
  singleJs: string;
  threadedJs: string;
  singleWasm: string;
  threadedWasm: string;
  threadedWorker?: string;
};

type SharedAssetResolverOptions = {
  root?: RuntimeRoot | null;
  moduleUrl: string;
  vendorDirectory: string;
  defaultBaseUrl?: string | (() => string);
  baseUrlGlobalProp?: string;
  assetNames: ThreadedAssetNames;
};

type EmscriptenModuleOptions = {
  getAssetUrl: (assetName: string) => string;
  threaded?: boolean;
  threadedJs: string;
  singleWasm: string;
  threadedWasm: string;
  threadedWasmAliases?: string[];
  threadedWorker?: string;
  noInitialRun?: boolean;
};

type RuntimeDiagnosticEvent = {
  context?: string;
  contextUrl?: string;
  failureMessage?: string;
  id: string;
  kind: "wasm";
  name: string;
  threaded: boolean;
  reason: string;
  timestamp: number;
  url: string;
};

type ThreadDecisionOptions<TModuleArg, TResult> = {
  moduleArg: TModuleArg;
  canTryThreaded: (moduleArg: TModuleArg) => boolean;
  isThreadedForced?: (moduleArg: TModuleArg) => boolean;
  threadedReason: string;
  fallbackReason: string;
  disabledReason: string;
  load: (threaded: boolean, reason: string) => Promise<TResult>;
  onThreadedError?: (error: RuntimeErrorLike) => void;
};

type FactoryLoaderSelectionOptions<TModuleArg, TModuleObject extends EmscriptenModuleObject> = {
  moduleArg: TModuleArg;
  canTryThreaded: (moduleArg: TModuleArg) => boolean;
  isThreadedForced?: (moduleArg: TModuleArg) => boolean;
  threadedReason: string;
  fallbackReason: string;
  disabledReason: string;
  createConfiguredModule: (moduleArg: TModuleArg, threaded: boolean) => TModuleObject;
  getFactory: (threaded: boolean) => Promise<(moduleObject: TModuleObject) => Promise<TModuleObject> | TModuleObject>;
  prepareModule?: (
    moduleObject: TModuleObject,
    threaded: boolean,
    reason: string,
    moduleArg: TModuleArg,
  ) => Promise<TModuleObject> | TModuleObject;
  finalizeModule?: (
    moduleObject: TModuleObject,
    threaded: boolean,
    reason: string,
    moduleArg: TModuleArg,
  ) => Promise<TModuleObject> | TModuleObject;
  onThreadedError?: (error: RuntimeErrorLike) => void;
};

type StandardThreadedFactoryLoaderOptions<TModuleArg, TModuleObject extends EmscriptenModuleObject> = {
  root: RuntimeRoot;
  moduleArg: TModuleArg;
  canTryThreaded: (moduleArg: TModuleArg) => boolean;
  isThreadedForced?: (moduleArg: TModuleArg) => boolean;
  createConfiguredModule: (moduleArg: TModuleArg, threaded: boolean) => TModuleObject;
  getFactory: (threaded: boolean) => Promise<(moduleObject: TModuleObject) => Promise<TModuleObject> | TModuleObject>;
  finalizeModule?: (
    moduleObject: TModuleObject,
    threaded: boolean,
    reason: string,
    moduleArg: TModuleArg,
  ) => Promise<TModuleObject> | TModuleObject;
  warningMessage: string;
};

type ThreadedSelectionPolicyOptions<TModuleArg> = {
  root: RuntimeRoot;
  isThreadedDisabled?: (moduleArg: TModuleArg) => boolean;
  isThreadedForced?: (moduleArg: TModuleArg) => boolean;
  canTryThreadedInNode?: (moduleArg: TModuleArg) => boolean;
  canTryThreadedInBrowser?: (moduleArg: TModuleArg, root: RuntimeRoot) => boolean;
};

type SharedThreadedWasmFactoryLoaderOptions<TModuleArg, TModuleObject extends EmscriptenModuleObject> = {
  root: RuntimeRoot;
  moduleArg: TModuleArg;
  canTryThreaded: (moduleArg: TModuleArg) => boolean;
  isThreadedForced?: (moduleArg: TModuleArg) => boolean;
  getAssetUrl: (assetName: string) => string;
  assetNames: ThreadedAssetNames;
  factoryExportExpression?: string;
  failureMessage: string;
  warningMessage: string;
  createModuleObject: (moduleArg: TModuleArg) => TModuleObject;
  prepareModuleObject?: (moduleObject: TModuleObject, threaded: boolean, moduleArg: TModuleArg) => TModuleObject;
  finalizeModule?: (
    moduleObject: TModuleObject,
    threaded: boolean,
    reason: string,
    moduleArg: TModuleArg,
  ) => Promise<TModuleObject> | TModuleObject;
  threadedWasmAliases?: string[];
  noInitialRun?: boolean;
};

type WorkerThreadModuleArg = {
  workerThreads?: number | string | null;
};

type SharedWasmToolLoaderOptions<
  TModuleArg extends WorkerThreadModuleArg,
  TModuleObject extends EmscriptenModuleObject,
> = {
  root: RuntimeRoot;
  moduleArg?: TModuleArg;
  getAssetUrl: (assetName: string) => string;
  assetNames: ThreadedAssetNames;
  failureMessage: string;
  warningMessage: string;
  createModuleObject?: (moduleArg: TModuleArg) => TModuleObject;
  prepareModuleObject?: (moduleObject: TModuleObject, threaded: boolean, moduleArg: TModuleArg) => TModuleObject;
  finalizeModule?: (
    moduleObject: TModuleObject,
    threaded: boolean,
    reason: string,
    moduleArg: TModuleArg,
    workerThreads: number | null,
  ) => Promise<TModuleObject> | TModuleObject;
  canTryThreadedInNode?: (moduleArg: TModuleArg, workerThreads: number | null) => boolean;
  canTryThreadedInBrowser?: (moduleArg: TModuleArg, root: RuntimeRoot, workerThreads: number | null) => boolean;
  isThreadedDisabled?: (moduleArg: TModuleArg, workerThreads: number | null) => boolean;
  isThreadedForced?: (moduleArg: TModuleArg, workerThreads: number | null) => boolean;
  threadedWasmAliases?: string[];
  noInitialRun?: boolean;
};

type DynamicImportFunction = <TModule extends object = object>(specifier: string) => Promise<TModule>;

let lastThreadedWasmFallbackError = "";

const getGlobalRoot = (): RuntimeRoot =>
  typeof globalThis === "undefined" ? (self as RuntimeRoot) : (globalThis as RuntimeRoot);

const isNodeRuntime = () => false;

const toNodePath = (fileUrl: string): string => fileUrl;

const basename = (filePath: string | { toString(): string } | null | undefined): string =>
  String(filePath || "").replace(PATH_DIRECTORY_PREFIX_REGEX, "");

const canUseBrowserThreads = (root?: RuntimeRoot | null): boolean =>
  typeof SharedArrayBuffer === "function" && !!root && root.crossOriginIsolated === true;

const getStandardThreadedDisabledReason = (
  root: RuntimeRoot,
  {
    browserDisabledReason = "threaded-disabled",
    browserUnavailableReason = "fallback",
  }: {
    browserDisabledReason?: string;
    browserUnavailableReason?: string;
  } = {},
) => (canUseBrowserThreads(root) ? browserDisabledReason : browserUnavailableReason);

const getOrCreateModuleObject = (root: RuntimeRoot): EmscriptenModuleObject => {
  const moduleObject = (root.Module || {}) as EmscriptenModuleObject;
  root.Module = moduleObject;
  return moduleObject;
};

const installRuntimeInitializedHook = (
  moduleObject: EmscriptenModuleObject,
  callback: (moduleObject: EmscriptenModuleObject) => void,
): EmscriptenModuleObject => {
  if (!moduleObject || typeof callback !== "function") return moduleObject;

  const previousOnRuntimeInitialized = moduleObject.onRuntimeInitialized;
  moduleObject.onRuntimeInitialized = function (this: object, ...args: RuntimeCallbackArgument[]) {
    if (previousOnRuntimeInitialized) previousOnRuntimeInitialized.apply(this, args);
    callback(moduleObject);
  };
  return moduleObject;
};

const installDeferredModuleMutation = <TModuleObject extends EmscriptenModuleObject>(
  moduleObject: TModuleObject,
  isReady: (moduleObject: TModuleObject) => boolean,
  mutate: (moduleObject: TModuleObject) => TModuleObject,
): TModuleObject => {
  if (!moduleObject) return moduleObject;
  if (isReady(moduleObject)) return mutate(moduleObject);
  return installRuntimeInitializedHook(moduleObject, () => mutate(moduleObject)) as TModuleObject;
};

const formatAbortMessage = (args: RuntimeCallbackArgument[]) =>
  args
    .map((arg) => {
      if (arg instanceof Error && arg.message) return arg.message;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch (_error) {
        return String(arg);
      }
    })
    .filter(Boolean)
    .join(" ");

const formatRuntimeErrorMessage = (error: RuntimeErrorLike) => {
  if (!error) return "";
  if (error instanceof Error) return error.stack || error.message || String(error);
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const errorRecord = error as { message?: unknown; type?: unknown; reason?: unknown };
    if (typeof errorRecord.message === "string" && errorRecord.message) return errorRecord.message;
    if (typeof errorRecord.reason === "string" && errorRecord.reason) return errorRecord.reason;
    try {
      return JSON.stringify(error);
    } catch (_jsonError) {
      return String(error);
    }
  }
  return String(error);
};

const installWasmAbortCapture = (moduleObject: EmscriptenModuleObject): EmscriptenModuleObject => {
  if (!moduleObject) return moduleObject;
  const previousOnAbort = moduleObject.onAbort;
  moduleObject.onAbort = function (this: object, ...args: RuntimeCallbackArgument[]) {
    moduleObject.__romWeaverWasmAbort = {
      args: args.slice(),
      message: formatAbortMessage(args),
      timestamp: Date.now(),
    };
    if (previousOnAbort) previousOnAbort.apply(this, args);
  };
  return moduleObject;
};

const createAssetUrlResolver = ({ root, assetUrls, defaultBaseUrl, baseUrlGlobalProp }: AssetUrlResolverOptions) => {
  const resolvedAssetUrls = assetUrls || {};
  let baseUrlCache: string | null = null;

  const getBaseUrl = () => {
    const rootWithStrings = root as (RuntimeRoot & Record<string, string | undefined>) | null | undefined;
    if (baseUrlGlobalProp && rootWithStrings && typeof rootWithStrings[baseUrlGlobalProp] === "string") {
      baseUrlCache = rootWithStrings[baseUrlGlobalProp] as string;
      return baseUrlCache;
    }
    if (baseUrlCache) return baseUrlCache;
    baseUrlCache = typeof defaultBaseUrl === "function" ? defaultBaseUrl() : defaultBaseUrl || "";
    return baseUrlCache;
  };

  return {
    getAssetUrl(assetName: string) {
      const rootWithStrings = root as (RuntimeRoot & Record<string, string | undefined>) | null | undefined;
      if (baseUrlGlobalProp && rootWithStrings && typeof rootWithStrings[baseUrlGlobalProp] === "string")
        return getBaseUrl() + assetName;
      return resolvedAssetUrls[assetName] || getBaseUrl() + assetName;
    },
    getBaseUrl,
  };
};

const createThreadedWasmAssetResolver = ({
  root,
  moduleUrl,
  vendorDirectory,
  defaultBaseUrl,
  baseUrlGlobalProp,
  assetNames,
}: SharedAssetResolverOptions) => {
  const moduleBaseUrl = new URL("./", moduleUrl).href;
  const modulePathname = new URL(moduleBaseUrl).pathname;
  const useSourceVendorAssets =
    modulePathname.indexOf("/src/workers/shared/") !== -1 ||
    modulePathname.indexOf("/src/workers/patch-checksum/") !== -1 ||
    modulePathname.indexOf("/src/workers/compression-") !== -1;
  const useBundledNodeAssets = isNodeRuntime() && !useSourceVendorAssets;
  const sourceVendorBaseUrl = ["..", "..", "..", "..", "vendor", "wasm", vendorDirectory, ""].join("/");
  const getSourceVendorAssetUrl = (assetName: string) => {
    const sourceModuleUrl = new URL(moduleUrl);
    const moduleSearch = VITE_TIMESTAMP_QUERY_REGEX.test(sourceModuleUrl.search) ? sourceModuleUrl.search : "";
    const sourceRootIndex = sourceModuleUrl.pathname.indexOf("/src/");
    if (sourceRootIndex !== -1) {
      sourceModuleUrl.pathname = `${sourceModuleUrl.pathname.slice(0, sourceRootIndex)}/vendor/wasm/${vendorDirectory}/${assetName}`;
      sourceModuleUrl.search = moduleSearch;
      sourceModuleUrl.hash = "";
      return sourceModuleUrl.href;
    }
    const sourceVendorAssetUrl = new URL(sourceVendorBaseUrl + assetName, moduleUrl);
    sourceVendorAssetUrl.search = moduleSearch;
    sourceVendorAssetUrl.hash = "";
    return sourceVendorAssetUrl.href;
  };
  const assetUrls = useSourceVendorAssets
    ? Object.values(assetNames).reduce(
        (urls, assetName) => {
          if (typeof assetName === "string" && assetName) urls[assetName] = getSourceVendorAssetUrl(assetName);
          return urls;
        },
        {} as Record<string, string>,
      )
    : null;

  return {
    moduleBaseUrl,
    useBundledNodeAssets,
    useSourceVendorAssets,
    ...createAssetUrlResolver({
      assetUrls: useBundledNodeAssets ? null : assetUrls,
      baseUrlGlobalProp,
      defaultBaseUrl,
      root,
    }),
  };
};

const createRuntimeDynamicImport = (): DynamicImportFunction => {
  try {
    return Function("specifier", "return import(specifier)") as DynamicImportFunction;
  } catch (_error) {
    try {
      const evaluateImport = globalThis.eval as (code: string) => unknown;
      return <TModule extends object = object>(specifier: string) =>
        evaluateImport(`import(${JSON.stringify(String(specifier || ""))})`) as Promise<TModule>;
    } catch (_innerError) {
      return <TModule extends object = object>(specifier: string) =>
        import(/* @vite-ignore */ specifier) as Promise<TModule>;
    }
  }
};

const importExternalModule = createRuntimeDynamicImport();

let runtimeDiagnosticSequence = 0;
const runtimeDiagnosticEvents: RuntimeDiagnosticEvent[] = [];
const runtimeDiagnosticContextId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const getRuntimeDiagnosticContext = (root: RuntimeRoot) => {
  const locationHref = root.location && typeof root.location.href === "string" ? root.location.href : undefined;
  if (typeof root.window === "object" && root.window === root) return { context: "window", contextUrl: locationHref };
  const workerName = typeof root.name === "string" && root.name ? root.name : "";
  if (workerName) return { context: `worker:${workerName}#${runtimeDiagnosticContextId}`, contextUrl: locationHref };
  if (typeof root.WorkerGlobalScope === "function" && root instanceof root.WorkerGlobalScope)
    return { context: `worker#${runtimeDiagnosticContextId}`, contextUrl: locationHref };
  return { context: "unknown", contextUrl: locationHref };
};

const emitRuntimeDiagnostic = (root: RuntimeRoot, event: RuntimeDiagnosticEvent) => {
  const diagnosticEvent = { ...getRuntimeDiagnosticContext(root), ...event };
  runtimeDiagnosticEvents.push(diagnosticEvent);
  if (runtimeDiagnosticEvents.length > 100) runtimeDiagnosticEvents.shift();
  try {
    if (typeof BroadcastChannel !== "function") return;
    const channel = new BroadcastChannel("rom-weaver-runtime-diagnostics");
    channel.postMessage(stampWorkerTransportMessage(diagnosticEvent));
    channel.close();
  } catch (_error) {
    /* diagnostics should never affect tool loading */
  }
};

const createModuleFactoryGetter = ({
  getAssetUrl,
  singleJs,
  threadedJs,
  failureMessage,
}: {
  getAssetUrl: (assetName: string) => string;
  singleJs: string;
  threadedJs: string;
  failureMessage: string;
}) => {
  const cache = new Map<
    string,
    Promise<(moduleObject: EmscriptenModuleObject) => Promise<EmscriptenModuleObject> | EmscriptenModuleObject>
  >();

  return (threaded: boolean) => {
    const assetUrl = getAssetUrl(threaded ? threadedJs : singleJs);
    const cacheKey = `factory:${assetUrl}`;
    if (!cache.has(cacheKey)) {
      cache.set(
        cacheKey,
        importExternalModule(assetUrl).then((namespace) => {
          const factory = (
            namespace as {
              default?: (
                moduleObject: EmscriptenModuleObject,
              ) => Promise<EmscriptenModuleObject> | EmscriptenModuleObject;
            }
          )?.default;
          if (typeof factory !== "function") throw new Error(failureMessage);
          return factory as (
            moduleObject: EmscriptenModuleObject,
          ) => Promise<EmscriptenModuleObject> | EmscriptenModuleObject;
        }),
      );
    }
    const cached = cache.get(cacheKey);
    if (!cached) throw new Error(`WASM loader cache entry missing for ${cacheKey}`);
    return cached;
  };
};

const prepareNodeWorkerScriptForRequire = async (scriptRef: string, rootParam?: RuntimeRoot) => {
  if (rootParam) void rootParam;
  return scriptRef;
};

const prepareNodeEmscriptenMainScript = async (moduleObject: EmscriptenModuleObject, root: RuntimeRoot) => {
  if (root) void root;
  return moduleObject;
};

const configureEmscriptenModule = (
  moduleObject: EmscriptenModuleObject,
  {
    getAssetUrl,
    threaded,
    threadedJs,
    singleWasm,
    threadedWasm,
    threadedWasmAliases,
    threadedWorker,
    noInitialRun,
  }: EmscriptenModuleOptions,
): EmscriptenModuleObject => {
  installWasmAbortCapture(moduleObject);
  const previousLocateFile = moduleObject.locateFile;
  const threadedWasmAliasSet =
    threaded && Array.isArray(threadedWasmAliases) ? new Set(threadedWasmAliases.filter(Boolean)) : null;
  if (noInitialRun) moduleObject.noInitialRun = true;
  moduleObject.locateFile = (path, scriptDirectory) => {
    if (path === threadedWasm) return getAssetUrl(threadedWasm);
    if (threadedWasmAliasSet?.has(path)) return getAssetUrl(threadedWasm);
    if (path === singleWasm) return getAssetUrl(singleWasm);
    if (path === threadedWorker || WORKER_SCRIPT_EXTENSION_REGEX.test(path)) return getAssetUrl(basename(path));
    if (typeof previousLocateFile === "function") return previousLocateFile(path, scriptDirectory);
    return (scriptDirectory || "") + path;
  };
  if (threaded) {
    moduleObject.mainScriptUrlOrBlob = toNodePath(getAssetUrl(threadedJs));
  } else if (
    moduleObject.mainScriptUrlOrBlob === getAssetUrl(threadedJs) ||
    moduleObject.mainScriptUrlOrBlob === toNodePath(getAssetUrl(threadedJs))
  ) {
    delete moduleObject.mainScriptUrlOrBlob;
  }
  return moduleObject;
};

const createThreadedSelectionPolicy = <TModuleArg>({
  root,
  isThreadedDisabled,
  isThreadedForced,
  canTryThreadedInNode,
  canTryThreadedInBrowser,
}: ThreadedSelectionPolicyOptions<TModuleArg>) => {
  const isDisabled = (moduleArg: TModuleArg) => isThreadedDisabled?.(moduleArg) === true;
  const isForced = (moduleArg: TModuleArg) => isThreadedForced?.(moduleArg) === true;
  const canTryThreaded = (moduleArg: TModuleArg) => {
    if (isDisabled(moduleArg)) return false;
    if (isNodeRuntime()) return canTryThreadedInNode ? canTryThreadedInNode(moduleArg) : isForced(moduleArg);
    if (canTryThreadedInBrowser) return canTryThreadedInBrowser(moduleArg, root);
    return canUseBrowserThreads(root);
  };

  return {
    canTryThreaded,
    isThreadedDisabled: isDisabled,
    isThreadedForced: isForced,
  };
};

const createThreadedFactoryLoader = async <TModuleArg, TModuleObject extends EmscriptenModuleObject>({
  moduleArg,
  canTryThreaded,
  isThreadedForced,
  threadedReason,
  fallbackReason,
  disabledReason,
  createConfiguredModule,
  getFactory,
  prepareModule,
  finalizeModule,
  onThreadedError,
}: FactoryLoaderSelectionOptions<TModuleArg, TModuleObject>) => {
  const loadSelected = async (threaded: boolean, reason: string) => {
    const selectedFactory = await getFactory(threaded);
    const configuredModule = await (prepareModule
      ? prepareModule(createConfiguredModule(moduleArg, threaded), threaded, reason, moduleArg)
      : createConfiguredModule(moduleArg, threaded));
    const moduleObject = await selectedFactory(configuredModule);
    return finalizeModule ? finalizeModule(moduleObject, threaded, reason, moduleArg) : moduleObject;
  };

  return loadThreadedWithFallback({
    canTryThreaded,
    disabledReason,
    fallbackReason,
    isThreadedForced,
    load: loadSelected,
    moduleArg,
    onThreadedError,
    threadedReason,
  });
};

const createStandardThreadedFactoryLoader = <TModuleArg, TModuleObject extends EmscriptenModuleObject>({
  root,
  moduleArg,
  canTryThreaded,
  isThreadedForced,
  createConfiguredModule,
  getFactory,
  finalizeModule,
  warningMessage,
}: StandardThreadedFactoryLoaderOptions<TModuleArg, TModuleObject>) =>
  createThreadedFactoryLoader({
    canTryThreaded,
    createConfiguredModule,
    disabledReason: canUseBrowserThreads(root) ? "threaded-disabled" : "fallback",
    fallbackReason: "threaded-fallback",
    finalizeModule,
    getFactory,
    isThreadedForced,
    moduleArg,
    onThreadedError: (error) => warnThreadedWasmFallback(root, warningMessage, error),
    prepareModule: (moduleObject) => prepareNodeEmscriptenMainScript(moduleObject, root) as Promise<TModuleObject>,
    threadedReason: isNodeRuntime() ? "node-threaded" : "browser-threaded",
  });

const createSharedThreadedWasmFactoryLoader = <TModuleArg, TModuleObject extends EmscriptenModuleObject>({
  root,
  moduleArg,
  canTryThreaded,
  isThreadedForced,
  getAssetUrl,
  assetNames,
  failureMessage,
  warningMessage,
  createModuleObject,
  prepareModuleObject,
  finalizeModule,
  threadedWasmAliases,
  noInitialRun,
}: SharedThreadedWasmFactoryLoaderOptions<TModuleArg, TModuleObject>) => {
  const getFactory = createModuleFactoryGetter({
    failureMessage,
    getAssetUrl,
    singleJs: assetNames.singleJs,
    threadedJs: assetNames.threadedJs,
  });

  return createStandardThreadedFactoryLoader({
    canTryThreaded,
    createConfiguredModule: (activeModuleArg, threaded) => {
      const configuredModule = prepareModuleObject
        ? prepareModuleObject(createModuleObject(activeModuleArg), threaded, activeModuleArg)
        : createModuleObject(activeModuleArg);
      return configureEmscriptenModule(configuredModule, {
        getAssetUrl,
        noInitialRun,
        singleWasm: assetNames.singleWasm,
        threaded,
        threadedJs: assetNames.threadedJs,
        threadedWasm: assetNames.threadedWasm,
        threadedWasmAliases,
        threadedWorker: assetNames.threadedWorker,
      }) as TModuleObject;
    },
    finalizeModule: finalizeModule
      ? (moduleObject, threaded, reason, activeModuleArg) => {
          const failureMessage = threaded ? "" : lastThreadedWasmFallbackError;
          emitRuntimeDiagnostic(root, {
            ...(failureMessage ? { failureMessage } : {}),
            id: `wasm:${Date.now()}:${++runtimeDiagnosticSequence}`,
            kind: "wasm",
            name: threaded ? assetNames.threadedWasm : assetNames.singleWasm,
            reason,
            threaded,
            timestamp: Date.now(),
            url: getAssetUrl(threaded ? assetNames.threadedWasm : assetNames.singleWasm),
          });
          return finalizeModule(moduleObject as TModuleObject, threaded, reason, activeModuleArg);
        }
      : (moduleObject, threaded, reason) => {
          const failureMessage = threaded ? "" : lastThreadedWasmFallbackError;
          emitRuntimeDiagnostic(root, {
            ...(failureMessage ? { failureMessage } : {}),
            id: `wasm:${Date.now()}:${++runtimeDiagnosticSequence}`,
            kind: "wasm",
            name: threaded ? assetNames.threadedWasm : assetNames.singleWasm,
            reason,
            threaded,
            timestamp: Date.now(),
            url: getAssetUrl(threaded ? assetNames.threadedWasm : assetNames.singleWasm),
          });
          return moduleObject as TModuleObject;
        },
    getFactory,
    isThreadedForced,
    moduleArg,
    root,
    warningMessage,
  });
};

const normalizeWasmWorkerThreads = (moduleArg?: WorkerThreadModuleArg | null) => {
  if (!moduleArg) return null;
  const value = Object.hasOwn(moduleArg, "workerThreads") ? moduleArg.workerThreads : undefined;
  if (value === undefined || value === null || value === "" || value === "auto") return null;
  if (value === 0 || value === "0") return 0;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.min(64, parsed)) : null;
};

const createConfiguredWasmToolLoader = <
  TModuleArg extends WorkerThreadModuleArg,
  TModuleObject extends EmscriptenModuleObject,
>({
  root,
  moduleArg,
  getAssetUrl,
  assetNames,
  failureMessage,
  warningMessage,
  createModuleObject,
  prepareModuleObject,
  finalizeModule,
  canTryThreadedInNode,
  canTryThreadedInBrowser,
  isThreadedDisabled,
  isThreadedForced,
  threadedWasmAliases,
  noInitialRun,
}: SharedWasmToolLoaderOptions<TModuleArg, TModuleObject>) => {
  const activeModuleArg = (moduleArg || {}) as TModuleArg;
  const selection = createThreadedSelectionPolicy<TModuleArg>({
    canTryThreadedInBrowser: canTryThreadedInBrowser
      ? (selectionModuleArg, selectionRoot) =>
          canTryThreadedInBrowser(selectionModuleArg, selectionRoot, normalizeWasmWorkerThreads(selectionModuleArg))
      : undefined,
    canTryThreadedInNode: (selectionModuleArg) =>
      canTryThreadedInNode
        ? canTryThreadedInNode(selectionModuleArg, normalizeWasmWorkerThreads(selectionModuleArg))
        : normalizeWasmWorkerThreads(selectionModuleArg) !== 0,
    isThreadedDisabled: (selectionModuleArg) =>
      isThreadedDisabled
        ? isThreadedDisabled(selectionModuleArg, normalizeWasmWorkerThreads(selectionModuleArg))
        : normalizeWasmWorkerThreads(selectionModuleArg) === 0,
    isThreadedForced: isThreadedForced
      ? (selectionModuleArg) => isThreadedForced(selectionModuleArg, normalizeWasmWorkerThreads(selectionModuleArg))
      : undefined,
    root,
  });

  return createSharedThreadedWasmFactoryLoader<TModuleArg, TModuleObject>({
    assetNames,
    canTryThreaded: selection.canTryThreaded,
    createModuleObject:
      createModuleObject || ((loaderModuleArg) => (loaderModuleArg || {}) as unknown as TModuleObject),
    failureMessage,
    finalizeModule: finalizeModule
      ? (moduleObject, threaded, reason, loaderModuleArg) =>
          finalizeModule(moduleObject, threaded, reason, loaderModuleArg, normalizeWasmWorkerThreads(loaderModuleArg))
      : undefined,
    getAssetUrl,
    isThreadedForced: selection.isThreadedForced,
    moduleArg: activeModuleArg,
    noInitialRun,
    prepareModuleObject,
    root,
    threadedWasmAliases,
    warningMessage,
  });
};

const loadThreadedWithFallback = async <TModuleArg, TResult>({
  moduleArg,
  canTryThreaded,
  isThreadedForced,
  threadedReason,
  fallbackReason,
  disabledReason,
  load,
  onThreadedError,
}: ThreadDecisionOptions<TModuleArg, TResult>) => {
  if (!canTryThreaded(moduleArg)) return load(false, disabledReason);

  try {
    lastThreadedWasmFallbackError = "";
    return await load(true, threadedReason);
  } catch (error) {
    if (isThreadedForced?.(moduleArg)) throw error;
    lastThreadedWasmFallbackError = formatRuntimeErrorMessage(
      error instanceof Error || typeof error === "string" || typeof error === "object" ? error : undefined,
    );
    if (onThreadedError)
      onThreadedError(
        error instanceof Error || typeof error === "string" || typeof error === "object" ? error : undefined,
      );
    try {
      return await load(false, fallbackReason);
    } finally {
      lastThreadedWasmFallbackError = "";
    }
  }
};

const warnThreadedWasmFallback = (_root: RuntimeRoot, _message: string, _error: RuntimeErrorLike) => {
  /* Worker diagnostics are forwarded through structured log messages by protocol clients. */
};

export type { EmscriptenModuleObject, RuntimeCallbackArgument, WasmToolLoaderModuleArg, WasmToolLoaderModuleObject };
export {
  canUseBrowserThreads,
  configureEmscriptenModule,
  createAssetUrlResolver,
  createConfiguredWasmToolLoader,
  createModuleFactoryGetter,
  createSharedThreadedWasmFactoryLoader,
  createThreadedSelectionPolicy,
  createThreadedWasmAssetResolver,
  getGlobalRoot,
  getOrCreateModuleObject,
  getStandardThreadedDisabledReason,
  importExternalModule,
  installDeferredModuleMutation,
  installRuntimeInitializedHook,
  installWasmAbortCapture,
  isNodeRuntime,
  loadThreadedWithFallback,
  normalizeWasmWorkerThreads,
  prepareNodeEmscriptenMainScript,
  prepareNodeWorkerScriptForRequire,
  warnThreadedWasmFallback,
};
