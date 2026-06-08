import type {
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverCommand,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
} from "rom-weaver-wasm";
import { collectRomWeaverRunInputPaths, readRomWeaverRunInputCommand } from "rom-weaver-wasm";
import browserWasmUrl from "rom-weaver-wasm/rom-weaver-app.wasm?url";
import { createBrowserWorkerClient } from "rom-weaver-wasm/workers/browser-client";
import browserRunnerWorkerUrl from "rom-weaver-wasm/workers/browser-runner-worker?worker&url";
import browserThreadWorkerUrl from "rom-weaver-wasm/workers/browser-wasi-thread-worker?worker&url";
import { getDefaultBrowserThreadCount } from "../../platform/shared/compression-options.ts";
import { type BrowserVirtualFile, getActiveBrowserVirtualFiles } from "../protocol/browser-virtual-files.ts";
import { isBrowserRuntime } from "../shared/runtime-env.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import { getRomWeaverRunEventLabel, isRomWeaverFailedRunEvent } from "./rom-weaver-run-events.ts";

type RomWeaverRunnerRunJsonOptions = RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, RuntimeValue> &
  RomWeaverBrowserOpfsRunOptions & { signal?: AbortSignal };
type RomWeaverRunnerRunJsonResult = RomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

type RomWeaverWorkerClient = {
  init: (...args: unknown[]) => Promise<RomWeaverRunnerReadyMetadata>;
  dispose?: () => Promise<void>;
  terminate?: () => void;
  runJson: (
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunnerRunJsonOptions,
  ) => Promise<RomWeaverRunnerRunJsonResult>;
};

type RomWeaverRunnerReadyMetadata = {
  mode: string;
  threaded: boolean;
  wasmUrl: string | null;
};

type RomWeaverRunner = {
  dispose?: () => Promise<void>;
  ready: RomWeaverRunnerReadyMetadata;
  runJson: (
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunnerRunJsonOptions,
  ) => Promise<RomWeaverRunnerRunJsonResult>;
  terminate?: () => void;
};

type BrowserWasmAssetSelection = {
  threadWorkerUrl?: string;
  wasmUrl?: string;
};

let browserThreadedRunnerPromise: Promise<RomWeaverRunner> | null = null;
let browserThreadedRunnerStale = false;
let activeRunnerRunCount = 0;

const describeVirtualFilesForTrace = (files: BrowserVirtualFile[]) => {
  let directCount = 0;
  let proxyCount = 0;
  let totalBytes = 0;
  for (const file of files) {
    if (file.proxy) {
      proxyCount += 1;
      totalBytes += file.proxy.size || 0;
    }
    if (file.source) {
      directCount += 1;
      const source = file.source as Blob | Uint8Array | ArrayBuffer;
      totalBytes +=
        source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size || 0;
    }
  }
  return {
    count: files.length,
    directCount,
    proxyCount,
    totalBytes,
  };
};

const emitRunnerTraceLine = (options: RomWeaverRunnerRunJsonOptions | undefined, message: string) => {
  options?.onTraceNonJsonLine?.(`[browser-runner] ${message}`);
};

const collectReferencedVirtualFilePaths = (
  commandOrRequest: RomWeaverRunInput,
  options?: RomWeaverRunnerRunJsonOptions,
) => {
  return new Set(
    collectRomWeaverRunInputPaths(commandOrRequest, {
      knownInputPaths: options?.knownInputPaths,
    }),
  );
};

const selectActiveVirtualFilesForRun = (
  activeVirtualFiles: BrowserVirtualFile[],
  commandOrRequest: RomWeaverRunInput,
  options?: RomWeaverRunnerRunJsonOptions,
) => {
  const command = readRomWeaverRunInputCommand(commandOrRequest);
  const referencedPaths = collectReferencedVirtualFilePaths(commandOrRequest, options);
  if (command.type === "compress" && [...referencedPaths].some((path) => /\.cue$/i.test(path))) {
    return activeVirtualFiles;
  }
  if (!referencedPaths.size) return activeVirtualFiles;
  return activeVirtualFiles.filter((file) => referencedPaths.has(file.path));
};

const resolveBrowserWasmUrl = async () => browserWasmUrl;

const resolveBrowserThreadWorkerUrl = async () => browserThreadWorkerUrl;

const resolveBrowserRunnerWorkerUrl = async () => browserRunnerWorkerUrl;

const canUseThreadedBrowserWasm = (root: typeof globalThis = globalThis) => {
  return typeof root.SharedArrayBuffer === "function" && root.crossOriginIsolated === true;
};

const resolveBrowserWasmAsset = async (): Promise<BrowserWasmAssetSelection> => {
  if (!canUseThreadedBrowserWasm()) {
    throw new Error("rom-weaver browser runtime requires SharedArrayBuffer and cross-origin isolation (COOP/COEP).");
  }
  const [wasmUrl, threadWorkerUrl] = await Promise.all([resolveBrowserWasmUrl(), resolveBrowserThreadWorkerUrl()]);
  return { threadWorkerUrl, wasmUrl };
};

const normalizeRunnerDefaultThreads = (workerThreads?: RuntimeValue) => {
  // Seed the thread-worker warm-up pool with the same count "auto" resolves to at run time
  // (max(4, hardwareConcurrency)) so the first command does not have to spawn extra worker shells.
  if (workerThreads === undefined || workerThreads === null) return getDefaultBrowserThreadCount();
  const raw = String(workerThreads).trim();
  if (!raw || raw.toLowerCase() === "auto") return getDefaultBrowserThreadCount();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const createBrowserRunnerInitOptions = (
  wasmAsset: BrowserWasmAssetSelection,
  options?: { workerThreads?: RuntimeValue },
) => {
  const defaultThreads = normalizeRunnerDefaultThreads(options?.workerThreads);
  return {
    runtimeMounts: [WORKER_OPFS_MOUNTPOINT],
    ...(wasmAsset.wasmUrl ? { wasmUrl: wasmAsset.wasmUrl } : {}),
    ...(wasmAsset.threadWorkerUrl ? { threadWorkerUrl: wasmAsset.threadWorkerUrl } : {}),
    ...(defaultThreads ? { defaultThreads } : {}),
    workGuestPath: WORKER_OPFS_MOUNTPOINT,
  };
};

/** Resolves a mid-run candidate selection request `{heading, candidates:[{value,label}]}` to a
 * 0-based index (or a negative value to cancel). Runs on the main thread. */
type InputSelectionHandler = (request: string) => number | Promise<number>;

let inputSelectionHandler: InputSelectionHandler | undefined;

/** Register the UI selection handler invoked when the wasm app needs the user to pick an input
 * candidate. When unset, selection is cancelled (returns -1) — the app always registers a handler. */
const setInputSelectionHandler = (handler?: InputSelectionHandler) => {
  inputSelectionHandler = handler;
};

const resolveInputSelection: InputSelectionHandler = (request) =>
  inputSelectionHandler ? inputSelectionHandler(request) : -1;

const createBrowserRunner = async (options?: { workerThreads?: RuntimeValue }): Promise<RomWeaverRunner> => {
  const runnerWorkerUrl = await resolveBrowserRunnerWorkerUrl();
  const client = createBrowserWorkerClient({ workerUrl: runnerWorkerUrl }) as unknown as RomWeaverWorkerClient;
  (client as { setSelectionHandler?: (handler: InputSelectionHandler) => void }).setSelectionHandler?.(
    resolveInputSelection,
  );
  const wasmAsset = await resolveBrowserWasmAsset();
  const ready = await client.init(createBrowserRunnerInitOptions(wasmAsset, options));
  const selectedWasmUrl = wasmAsset.wasmUrl ?? ready.wasmUrl ?? "";
  publishRomWeaverWasmDiagnostic({
    context: "rom-weaver browser runner",
    contextUrl: selectedWasmUrl,
    reason: "cross-origin isolated",
    threaded: ready.threaded,
    url: ready.wasmUrl || selectedWasmUrl,
  });
  return {
    dispose: async () => {
      // Gracefully release the worker's resources (OPFS sync access handles, thread pool) first,
      // then terminate the Worker thread itself. `dispose()` alone leaves the worker — and its wasm
      // linear memory, which only ever grows — alive, so recycling it would leak the grown heap.
      await client.dispose?.().catch(() => undefined);
      client.terminate?.();
    },
    ready,
    runJson: (commandOrRequest, options) => client.runJson(commandOrRequest, options),
    terminate: () => client.terminate?.(),
  };
};

const createRomWeaverRunner = async (options?: { workerThreads?: RuntimeValue }) => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  if (browserThreadedRunnerStale && activeRunnerRunCount === 0) await resetRomWeaverRunner();
  const workerThreads = options?.workerThreads;
  if (!browserThreadedRunnerPromise)
    browserThreadedRunnerPromise = createBrowserRunner({ workerThreads }).catch((error) => {
      browserThreadedRunnerPromise = null;
      throw error;
    });
  return browserThreadedRunnerPromise;
};

const resetRomWeaverRunner = async (options: { terminate?: boolean } = {}) => {
  const activeRunnerPromises = [browserThreadedRunnerPromise].filter(
    (entry): entry is Promise<RomWeaverRunner> => !!entry,
  );
  browserThreadedRunnerPromise = null;
  browserThreadedRunnerStale = false;
  if (!activeRunnerPromises.length) return;
  const disposedRunners = new Set<RomWeaverRunner>();
  for (const activeRunnerPromise of activeRunnerPromises) {
    const runner = await activeRunnerPromise.catch(() => null);
    if (!runner || disposedRunners.has(runner)) continue;
    disposedRunners.add(runner);
    if (options.terminate) runner.terminate?.();
    else await runner.dispose?.().catch(() => undefined);
  }
};

const markRomWeaverRunnerStale = () => {
  browserThreadedRunnerStale = true;
  if (activeRunnerRunCount === 0) void resetRomWeaverRunner();
};

// The wasm runner's linear memory only ever grows, so the browser surfaces an exhausted heap as a
// `RangeError: Out of memory`. Detect it so we can recycle the worker onto a clean heap.
const isRunnerOutOfMemoryError = (error: unknown): boolean =>
  error instanceof Error && error.name === "RangeError" && /out of memory/i.test(error.message);

const createRunnerAbortError = () => {
  const error = new Error("Workflow was cancelled") as Error & { code?: string };
  error.name = "AbortError";
  error.code = "CANCELLED";
  return error;
};

const runRomWeaverJson = async (commandOrRequest: RomWeaverRunInput, options?: RomWeaverRunnerRunJsonOptions) => {
  const { signal, ...runOptionOverrides } = options || {};
  const activeVirtualFiles = getActiveBrowserVirtualFiles();
  const scopedActiveVirtualFiles = selectActiveVirtualFilesForRun(activeVirtualFiles, commandOrRequest, options);
  const configuredVirtualFiles = runOptionOverrides.virtualFiles;
  // Cached OPFS mounts hold sync access handles; release them before UI-side VFS writes/downloads.
  const defaultInvalidateMountCacheAfterRun = true;
  const runOptions: RomWeaverRunnerRunJsonOptions =
    scopedActiveVirtualFiles.length > 0
      ? {
          ...runOptionOverrides,
          virtualFiles: [
            ...scopedActiveVirtualFiles,
            ...(Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles : []),
          ],
        }
      : {
          ...runOptionOverrides,
        };
  if (!Object.hasOwn(runOptions, "invalidateMountCacheAfterRun")) {
    runOptions.invalidateMountCacheAfterRun = defaultInvalidateMountCacheAfterRun;
  }
  // Let the app prompt (via the host selection callback) when a container has multiple selectable
  // entries and no explicit selection. Commands that pass an explicit `--select` never reach it.
  if (!Object.hasOwn(runOptions, "interactiveSelectionEnabled")) {
    (runOptions as { interactiveSelectionEnabled?: boolean }).interactiveSelectionEnabled = true;
  }
  emitRunnerTraceLine(
    options,
    `runJson preparing command=${formatCommandForTrace(commandOrRequest)} activeVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(activeVirtualFiles),
    )} scopedVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(scopedActiveVirtualFiles),
    )} configuredVirtualFiles=${Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles.length : 0} invalidateMountCacheAfterRun=${String(runOptions.invalidateMountCacheAfterRun)}`,
  );
  const dispatchRun = async () => {
    if (signal?.aborted) throw createRunnerAbortError();
    const runner = await createRomWeaverRunner();
    if (signal?.aborted) throw createRunnerAbortError();
    emitRunnerTraceLine(
      options,
      `runJson dispatch mode=${runner.ready.mode} threaded=${String(runner.ready.threaded)}`,
    );
    activeRunnerRunCount += 1;
    try {
      return await runner.runJson(commandOrRequest, runOptions);
    } finally {
      activeRunnerRunCount = Math.max(0, activeRunnerRunCount - 1);
      if (activeRunnerRunCount === 0 && browserThreadedRunnerStale) void resetRomWeaverRunner();
    }
  };
  const dispatchRunWithAbort = () => {
    if (!signal) return dispatchRun();
    if (signal.aborted) {
      emitRunnerTraceLine(options, "runJson aborted before dispatch; terminating active runner");
      browserThreadedRunnerStale = true;
      void resetRomWeaverRunner({ terminate: true });
      return Promise.reject(createRunnerAbortError());
    }
    return new Promise<RomWeaverRunnerRunJsonResult>((resolve, reject) => {
      let settled = false;
      const abortRun = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abortRun);
        emitRunnerTraceLine(options, "runJson aborted; terminating active runner");
        browserThreadedRunnerStale = true;
        void resetRomWeaverRunner({ terminate: true });
        reject(createRunnerAbortError());
      };
      signal.addEventListener("abort", abortRun, { once: true });
      dispatchRun().then(
        (result) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abortRun);
          resolve(result);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abortRun);
          reject(error);
        },
      );
    });
  };
  try {
    return await dispatchRunWithAbort();
  } catch (error) {
    // A long-lived worker can exhaust its (only-ever-growing) wasm heap after several heavy ops and
    // fail a later run with an out-of-memory error. Flag the exhausted worker stale so the next
    // dispatch recycles it onto a clean heap, then surface the error rather than retrying the run.
    if (isRunnerOutOfMemoryError(error)) {
      emitRunnerTraceLine(options, "runJson out-of-memory; flagging worker stale for recycle on next dispatch");
      browserThreadedRunnerStale = true;
    }
    throw error;
  }
};

const warmupRomWeaverRunner = async (workerThreads?: RuntimeValue) => {
  const runner = await createRomWeaverRunner({ workerThreads });
  return runner.ready;
};

const getRomWeaverRunnerMetadata = async () => {
  return (await createRomWeaverRunner()).ready;
};

const publishRomWeaverWasmDiagnostic = (message: {
  context?: string;
  contextUrl?: string;
  reason?: string;
  threaded: boolean;
  url: string;
}) => {
  if (typeof BroadcastChannel !== "function") return;
  try {
    const channel = new BroadcastChannel("rom-weaver-runtime-diagnostics");
    channel.postMessage({
      id: `rom-weaver-runner:${message.url}`,
      kind: "wasm",
      name: getResourceName(message.url),
      ...message,
    });
    channel.close();
  } catch (_err) {
    // diagnostics are best-effort
  }
};

const getResourceName = (urlLike: string) => {
  try {
    const url = new URL(urlLike, globalThis.location?.href || "http://localhost/");
    return url.pathname.split("/").filter(Boolean).pop() || "rom-weaver-app.wasm";
  } catch (_err) {
    return urlLike.split("/").filter(Boolean).pop() || "rom-weaver-app.wasm";
  }
};

const formatCommandForTrace = (commandOrRequest: RomWeaverRunInput) => {
  const command: RomWeaverCommand = readRomWeaverRunInputCommand(commandOrRequest);
  try {
    return JSON.stringify(command);
  } catch (_err) {
    return String(command.type || "unknown");
  }
};

const getErrorMessage = (value: unknown) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return String(value.message || "").trim();
  if (typeof value === "object") {
    const record = value as { message?: unknown; kind?: unknown; context?: unknown };
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : typeof record.kind === "string" && record.kind.trim()
          ? `rom-weaver error (${record.kind.trim()})`
          : "";
    if (!message) return "";
    if (!(record.context && typeof record.context === "object")) return message;
    const command =
      "command" in record.context && typeof (record.context as { command?: unknown }).command === "string"
        ? (record.context as { command: string }).command.trim()
        : "";
    const stage =
      "stage" in record.context && typeof (record.context as { stage?: unknown }).stage === "string"
        ? (record.context as { stage: string }).stage.trim()
        : "";
    if (!(command || stage)) return message;
    const contextParts = [command ? `command=${command}` : "", stage ? `stage=${stage}` : ""].filter((part) => !!part);
    return `${message} (${contextParts.join(", ")})`;
  }
  return "";
};

const getRomWeaverFailureMessage = (
  result: Partial<RomWeaverRunnerRunJsonResult> | null | undefined,
  fallback = "rom-weaver operation failed",
) => {
  const events = Array.isArray(result?.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!(event && isRomWeaverFailedRunEvent(event))) continue;
    const label = getRomWeaverRunEventLabel(event).trim();
    if (label) return label;
  }

  const nonJsonLines = Array.isArray(result?.nonJsonLines) ? result.nonJsonLines : [];
  for (let index = nonJsonLines.length - 1; index >= 0; index -= 1) {
    const line = String(nonJsonLines[index] || "").trim();
    if (line) return line;
  }

  const errorMessage = getErrorMessage((result as { error?: unknown } | null | undefined)?.error);
  if (errorMessage) return errorMessage;

  const stderr = getNonTraceStderr(result);
  if (stderr) return stderr;

  return fallback;
};

const TRACE_STDERR_LINE_REGEX = /^\d{4}-\d{2}-\d{2}T\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+[\w:]+:/;

const getNonTraceStderr = (result: Partial<RomWeaverRunnerRunJsonResult> | null | undefined) => {
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (!stderr) return "";
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !TRACE_STDERR_LINE_REGEX.test(line));
  return lines.join("\n").trim();
};

export type {
  RomWeaverRunJsonEvent,
  RomWeaverRunnerRunJsonOptions as RomWeaverRunJsonOptions,
  RomWeaverRunnerRunJsonResult as RomWeaverRunJsonResult,
};
export {
  getRomWeaverFailureMessage,
  getRomWeaverRunnerMetadata,
  markRomWeaverRunnerStale,
  resetRomWeaverRunner,
  runRomWeaverJson,
  setInputSelectionHandler,
  warmupRomWeaverRunner,
};
