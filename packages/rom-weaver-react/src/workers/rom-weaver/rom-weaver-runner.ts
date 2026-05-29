import { type BrowserVirtualFile, getActiveBrowserVirtualFiles } from "../protocol/browser-virtual-files.ts";
import { isBrowserRuntime } from "../shared/runtime-env.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import type { RomWeaverCommand, RomWeaverProgressEvent, RomWeaverRunRequest } from "rom-weaver-wasm";

type RomWeaverRunJsonEvent = RomWeaverProgressEvent;
type RomWeaverRunJsonInput = RomWeaverCommand | RomWeaverRunRequest;

type RomWeaverRunJsonOptions = {
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onNonJsonLine?: (line: string) => void;
  preferThreadedWasm?: boolean;
  onTraceEvent?: (event: RuntimeValue) => void;
  onTraceNonJsonLine?: (line: string) => void;
  [key: string]: RuntimeValue;
};

type RomWeaverRunJsonResult = {
  command: RomWeaverCommand;
  exitCode: number;
  ok: boolean;
  request: RomWeaverRunRequest;
  stdout?: string;
  stderr?: string;
  events: RomWeaverRunJsonEvent[];
  nonJsonLines: string[];
  traceEvents: RuntimeValue[];
  traceNonJsonLines: string[];
};

type RomWeaverWorkerClient = {
  init: (...args: unknown[]) => Promise<RomWeaverRunnerReadyMetadata>;
  dispose?: () => Promise<void>;
  runJson: (commandOrRequest: RomWeaverRunJsonInput, options?: RomWeaverRunJsonOptions) => Promise<RomWeaverRunJsonResult>;
};

type RomWeaverRunnerReadyMetadata = {
  fallbackReason?: string;
  mode: string;
  threaded: boolean;
  wasmUrl: string | null;
};

type RomWeaverRunner = {
  dispose?: () => Promise<void>;
  ready: RomWeaverRunnerReadyMetadata;
  runJson: (commandOrRequest: RomWeaverRunJsonInput, options?: RomWeaverRunJsonOptions) => Promise<RomWeaverRunJsonResult>;
};

type BrowserWasmAssetSelection = {
  threadWorkerUrl?: string;
  threadedWasmUrl?: string;
  wasmUrl?: string;
};

let browserSingleThreadedWasmUrlPromise: Promise<string> | null = null;
let browserThreadedWasmUrlPromise: Promise<string> | null = null;
let browserThreadWorkerUrlPromise: Promise<string> | null = null;
let browserThreadedRunnerPromise: Promise<RomWeaverRunner> | null = null;
let browserSingleThreadRunnerPromise: Promise<RomWeaverRunner> | null = null;

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
      totalBytes += source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size || 0;
    }
  }
  return {
    count: files.length,
    directCount,
    proxyCount,
    totalBytes,
  };
};

const emitRunnerTraceLine = (options: RomWeaverRunJsonOptions | undefined, message: string) => {
  options?.onTraceNonJsonLine?.(`[browser-runner] ${message}`);
};

const readWasmUrlModuleDefault = (module: { default?: unknown }, fallback: string) => {
  const candidate = module.default;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return fallback;
};

const resolveBrowserSingleThreadedWasmUrl = async () => {
  if (!browserSingleThreadedWasmUrlPromise) {
    browserSingleThreadedWasmUrlPromise = import("rom-weaver-wasm/rom-weaver-app.wasm?url")
      .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/rom-weaver-app.wasm"))
      .catch(() => "rom-weaver-wasm/rom-weaver-app.wasm");
  }
  return browserSingleThreadedWasmUrlPromise;
};

const resolveBrowserThreadedWasmUrl = async () => {
  if (!browserThreadedWasmUrlPromise) {
    browserThreadedWasmUrlPromise = import("rom-weaver-wasm/rom-weaver-app-threaded.wasm?url")
      .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/rom-weaver-app-threaded.wasm"))
      .catch(() => "rom-weaver-wasm/rom-weaver-app-threaded.wasm");
  }
  return browserThreadedWasmUrlPromise;
};

const resolveBrowserThreadWorkerUrl = async () => {
  if (!browserThreadWorkerUrlPromise) {
    browserThreadWorkerUrlPromise = import("rom-weaver-wasm/workers/browser-wasi-thread-worker?worker&url")
      .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/workers/browser-wasi-thread-worker"))
      .catch(() => "rom-weaver-wasm/workers/browser-wasi-thread-worker");
  }
  return browserThreadWorkerUrlPromise;
};

const canUseThreadedBrowserWasm = (root: typeof globalThis = globalThis) => {
  return typeof root.SharedArrayBuffer === "function" && root.crossOriginIsolated === true;
};

const resolveBrowserWasmAsset = async (): Promise<BrowserWasmAssetSelection> => {
  if (!canUseThreadedBrowserWasm()) {
    return { wasmUrl: await resolveBrowserSingleThreadedWasmUrl() };
  }
  const [threadedWasmUrl, threadWorkerUrl] = await Promise.all([
    resolveBrowserThreadedWasmUrl(),
    resolveBrowserThreadWorkerUrl(),
  ]);
  return { threadedWasmUrl, threadWorkerUrl };
};

const normalizeRunnerDefaultThreads = (workerThreads?: RuntimeValue) => {
  if (workerThreads === undefined || workerThreads === null) return undefined;
  const raw = String(workerThreads).trim();
  if (!raw || raw.toLowerCase() === "auto") return undefined;
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
    ...(wasmAsset.threadedWasmUrl ? { threadedWasmUrl: wasmAsset.threadedWasmUrl } : {}),
    ...(wasmAsset.threadWorkerUrl ? { threadWorkerUrl: wasmAsset.threadWorkerUrl } : {}),
    ...(wasmAsset.wasmUrl ? { wasmUrl: wasmAsset.wasmUrl } : {}),
    ...(defaultThreads ? { defaultThreads } : {}),
    workGuestPath: WORKER_OPFS_MOUNTPOINT,
  };
};

const getThreadedFallbackReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return `threaded wasm fallback: ${message}`;
};

const createBrowserRunner = async (
  preferThreadedWasm = true,
  options?: { workerThreads?: RuntimeValue },
): Promise<RomWeaverRunner> => {
  const { createBrowserWorkerClient } = await import("rom-weaver-wasm/workers/browser-client");
  let client = createBrowserWorkerClient() as unknown as RomWeaverWorkerClient;
  let wasmAsset: BrowserWasmAssetSelection = preferThreadedWasm
    ? await resolveBrowserWasmAsset()
    : { wasmUrl: await resolveBrowserSingleThreadedWasmUrl() };
  let ready: RomWeaverRunnerReadyMetadata;
  let fallbackReason: string | undefined;
  if (preferThreadedWasm) {
    try {
      ready = await client.init(createBrowserRunnerInitOptions(wasmAsset, options));
    } catch (error) {
      if (!wasmAsset.threadedWasmUrl) throw error;
      await client.dispose?.().catch(() => undefined);
      fallbackReason = getThreadedFallbackReason(error);
      client = createBrowserWorkerClient() as unknown as RomWeaverWorkerClient;
      wasmAsset = { wasmUrl: await resolveBrowserSingleThreadedWasmUrl() };
      ready = await client.init({
        ...createBrowserRunnerInitOptions(wasmAsset, options),
        preferThreadedWasm: false,
      });
    }
  } else {
    ready = await client.init({
      ...createBrowserRunnerInitOptions(wasmAsset, options),
      preferThreadedWasm: false,
    });
  }
  const selectedWasmUrl = ready.threaded
    ? (wasmAsset.threadedWasmUrl ?? ready.wasmUrl ?? "")
    : (wasmAsset.wasmUrl ?? ready.wasmUrl ?? "");
  const runnerReady = fallbackReason ? { ...ready, fallbackReason } : ready;
  publishRomWeaverWasmDiagnostic({
    context: "rom-weaver browser runner",
    contextUrl: selectedWasmUrl,
    reason: ready.threaded ? "cross-origin isolated" : (fallbackReason ?? "single-thread runtime"),
    threaded: runnerReady.threaded,
    url: ready.wasmUrl || selectedWasmUrl,
  });
  return {
    dispose: async () => {
      await client.dispose?.().catch(() => undefined);
    },
    ready: runnerReady,
    runJson: (commandOrRequest, options) => client.runJson(commandOrRequest, options),
  };
};

const createRomWeaverRunner = async (options?: { preferThreadedWasm?: boolean; workerThreads?: RuntimeValue }) => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  const preferThreadedWasm = options?.preferThreadedWasm !== false;
  const workerThreads = options?.workerThreads;
  if (!preferThreadedWasm) {
    if (!browserSingleThreadRunnerPromise)
      browserSingleThreadRunnerPromise = createBrowserRunner(false, { workerThreads }).catch((error) => {
        browserSingleThreadRunnerPromise = null;
        throw error;
      });
    return browserSingleThreadRunnerPromise;
  }
  if (!browserThreadedRunnerPromise)
    browserThreadedRunnerPromise = createBrowserRunner(true, { workerThreads }).catch((error) => {
      browserThreadedRunnerPromise = null;
      throw error;
    });
  return browserThreadedRunnerPromise;
};

const resetRomWeaverRunner = async () => {
  const activeRunnerPromises = [browserThreadedRunnerPromise, browserSingleThreadRunnerPromise].filter(
    (entry): entry is Promise<RomWeaverRunner> => !!entry,
  );
  browserThreadedRunnerPromise = null;
  browserSingleThreadRunnerPromise = null;
  if (!activeRunnerPromises.length) return;
  const disposedRunners = new Set<RomWeaverRunner>();
  for (const activeRunnerPromise of activeRunnerPromises) {
    const runner = await activeRunnerPromise.catch(() => null);
    if (!runner || disposedRunners.has(runner)) continue;
    disposedRunners.add(runner);
    await runner.dispose?.().catch(() => undefined);
  }
};

const runRomWeaverJson = async (commandOrRequest: RomWeaverRunJsonInput, options?: RomWeaverRunJsonOptions) => {
  const preferThreadedWasm = options?.preferThreadedWasm !== false;
  const activeVirtualFiles = getActiveBrowserVirtualFiles();
  const configuredVirtualFiles = options?.virtualFiles;
  const runOptionOverrides = { ...(options || {}) };
  delete runOptionOverrides.preferThreadedWasm;
  const defaultInvalidateMountCacheAfterRun = activeVirtualFiles.length > 0;
  const runOptions: RomWeaverRunJsonOptions =
    activeVirtualFiles.length > 0
      ? {
          ...runOptionOverrides,
          virtualFiles: [
            ...activeVirtualFiles,
            ...(Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles : []),
          ],
        }
      : {
          ...runOptionOverrides,
        };
  if (!Object.prototype.hasOwnProperty.call(runOptions, "invalidateMountCacheAfterRun")) {
    runOptions.invalidateMountCacheAfterRun = defaultInvalidateMountCacheAfterRun;
  }
  emitRunnerTraceLine(
    options,
    `runJson preparing command=${formatCommandForTrace(commandOrRequest)} activeVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(activeVirtualFiles),
    )} configuredVirtualFiles=${Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles.length : 0} preferThreadedWasm=${String(preferThreadedWasm)} invalidateMountCacheAfterRun=${String(runOptions.invalidateMountCacheAfterRun)}`,
  );
  const runner = await createRomWeaverRunner({ preferThreadedWasm });
  emitRunnerTraceLine(
    options,
    `runJson dispatch mode=${runner.ready.mode} threaded=${String(runner.ready.threaded)} fallbackReason=${
      runner.ready.fallbackReason || ""
    }`,
  );
  return runner.runJson(commandOrRequest, runOptions);
};

const warmupRomWeaverRunner = async (workerThreads?: RuntimeValue) => {
  const runner = await createRomWeaverRunner({ workerThreads });
  return runner.ready;
};

const getRomWeaverRunnerMetadata = async (options?: { preferThreadedWasm?: boolean }) => {
  return (await createRomWeaverRunner(options)).ready;
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

const formatCommandForTrace = (commandOrRequest: RomWeaverRunJsonInput) => {
  const command: RomWeaverCommand =
    isRomWeaverRunRequest(commandOrRequest)
      ? commandOrRequest.command
      : commandOrRequest;
  try {
    return JSON.stringify(command);
  } catch (_err) {
    return String(command.type || "unknown");
  }
};

const isRomWeaverRunRequest = (value: RomWeaverRunJsonInput): value is RomWeaverRunRequest => {
  return "command" in value && Boolean(value.command);
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
  result: Partial<RomWeaverRunJsonResult> | null | undefined,
  fallback = "rom-weaver operation failed",
) => {
  const events = Array.isArray(result?.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!(event && event.status === "failed")) continue;
    const label = typeof event.label === "string" ? event.label.trim() : "";
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

const getNonTraceStderr = (result: Partial<RomWeaverRunJsonResult> | null | undefined) => {
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (!stderr) return "";
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !TRACE_STDERR_LINE_REGEX.test(line));
  return lines.join("\n").trim();
};

export type { RomWeaverRunJsonEvent, RomWeaverRunJsonOptions, RomWeaverRunJsonResult };
export {
  getRomWeaverFailureMessage,
  getRomWeaverRunnerMetadata,
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
};
