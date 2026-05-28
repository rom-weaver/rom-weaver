import { type BrowserVirtualFile, getActiveBrowserVirtualFiles } from "../protocol/browser-virtual-files.ts";
import { isBrowserRuntime } from "../shared/runtime-env.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";

type RomWeaverRunJsonEvent = {
  label?: string;
  percent?: number | null;
  stage?: string;
  status?: string;
  [key: string]: RuntimeValue;
};

type RomWeaverRunJsonOptions = {
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onNonJsonLine?: (line: string) => void;
  onTraceEvent?: (event: RuntimeValue) => void;
  onTraceNonJsonLine?: (line: string) => void;
  [key: string]: RuntimeValue;
};

type RomWeaverRunJsonResult = {
  args: string[];
  exitCode: number;
  ok: boolean;
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
  runJson: (args?: unknown[], options?: RomWeaverRunJsonOptions) => Promise<RomWeaverRunJsonResult>;
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
  runJson: (args: string[], options?: RomWeaverRunJsonOptions) => Promise<RomWeaverRunJsonResult>;
};

type BrowserWasmAssetSelection = {
  threadWorkerUrl?: string;
  threadedWasmUrl?: string;
  wasmUrl?: string;
};

let browserSingleThreadedWasmUrlPromise: Promise<string> | null = null;
let browserThreadedWasmUrlPromise: Promise<string> | null = null;
let browserThreadWorkerUrlPromise: Promise<string> | null = null;
let browserRunnerPromise: Promise<RomWeaverRunner> | null = null;

const normalizeArgs = (args: string[]) => args.map((value) => String(value));

const describeVirtualFilesForTrace = (files: BrowserVirtualFile[]) => {
  let proxyCount = 0;
  let totalBytes = 0;
  for (const file of files) {
    if (file.proxy) {
      proxyCount += 1;
      totalBytes += file.proxy.size || 0;
    }
  }
  return {
    count: files.length,
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
    browserSingleThreadedWasmUrlPromise = import("rom-weaver-wasm/rom-weaver-cli.wasm?url")
      .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/rom-weaver-cli.wasm"))
      .catch(() => "rom-weaver-wasm/rom-weaver-cli.wasm");
  }
  return browserSingleThreadedWasmUrlPromise;
};

const resolveBrowserThreadedWasmUrl = async () => {
  if (!browserThreadedWasmUrlPromise) {
    browserThreadedWasmUrlPromise = import("rom-weaver-wasm/rom-weaver-cli-threaded.wasm?url")
      .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/rom-weaver-cli-threaded.wasm"))
      .catch(() => "rom-weaver-wasm/rom-weaver-cli-threaded.wasm");
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

const createBrowserRunnerInitOptions = (wasmAsset: BrowserWasmAssetSelection) => {
  return {
    runtimeMounts: [WORKER_OPFS_MOUNTPOINT],
    ...(wasmAsset.threadedWasmUrl ? { threadedWasmUrl: wasmAsset.threadedWasmUrl } : {}),
    ...(wasmAsset.threadWorkerUrl ? { threadWorkerUrl: wasmAsset.threadWorkerUrl } : {}),
    ...(wasmAsset.wasmUrl ? { wasmUrl: wasmAsset.wasmUrl } : {}),
    workGuestPath: WORKER_OPFS_MOUNTPOINT,
  };
};

const getThreadedFallbackReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return `threaded wasm fallback: ${message}`;
};

const createBrowserRunner = async (): Promise<RomWeaverRunner> => {
  const { createBrowserWorkerClient } = await import("rom-weaver-wasm/workers/browser-client");
  let client = createBrowserWorkerClient() as unknown as RomWeaverWorkerClient;
  let wasmAsset = await resolveBrowserWasmAsset();
  let ready: RomWeaverRunnerReadyMetadata;
  let fallbackReason: string | undefined;
  try {
    ready = await client.init(createBrowserRunnerInitOptions(wasmAsset));
  } catch (error) {
    if (!wasmAsset.threadedWasmUrl) throw error;
    await client.dispose?.().catch(() => undefined);
    fallbackReason = getThreadedFallbackReason(error);
    client = createBrowserWorkerClient() as unknown as RomWeaverWorkerClient;
    wasmAsset = { wasmUrl: await resolveBrowserSingleThreadedWasmUrl() };
    ready = await client.init({
      ...createBrowserRunnerInitOptions(wasmAsset),
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
    runJson: (args, options) => client.runJson(normalizeArgs(args), options),
  };
};

const createRomWeaverRunner = async () => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  if (!browserRunnerPromise)
    browserRunnerPromise = createBrowserRunner().catch((error) => {
      browserRunnerPromise = null;
      throw error;
    });
  return browserRunnerPromise;
};

const resetRomWeaverRunner = async () => {
  const activeRunnerPromise = browserRunnerPromise;
  browserRunnerPromise = null;
  if (!activeRunnerPromise) return;
  const runner = await activeRunnerPromise.catch(() => null);
  await runner?.dispose?.().catch(() => undefined);
};

const runRomWeaverJson = async (args: string[], options?: RomWeaverRunJsonOptions) => {
  const activeVirtualFiles = getActiveBrowserVirtualFiles();
  const configuredVirtualFiles = (options as { virtualFiles?: unknown[] } | undefined)?.virtualFiles;
  emitRunnerTraceLine(
    options,
    `runJson preparing args=${JSON.stringify(normalizeArgs(args))} activeVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(activeVirtualFiles),
    )} configuredVirtualFiles=${Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles.length : 0}`,
  );
  const runOptions =
    activeVirtualFiles.length > 0
      ? {
          ...(options ?? {}),
          invalidateMountCacheAfterRun: true,
          virtualFiles: [
            ...activeVirtualFiles,
            ...(Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles : []),
          ],
        }
      : {
          ...(options ?? {}),
          invalidateMountCacheAfterRun: true,
        };
  const runner = await createRomWeaverRunner();
  emitRunnerTraceLine(
    options,
    `runJson dispatch mode=${runner.ready.mode} threaded=${String(runner.ready.threaded)} fallbackReason=${
      runner.ready.fallbackReason || ""
    }`,
  );
  return runner.runJson(args, runOptions);
};

const warmupRomWeaverRunner = async (workerThreads?: RuntimeValue) => {
  void workerThreads;
  const runner = await createRomWeaverRunner();
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
    return url.pathname.split("/").filter(Boolean).pop() || "rom-weaver-cli.wasm";
  } catch (_err) {
    return urlLike.split("/").filter(Boolean).pop() || "rom-weaver-cli.wasm";
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
