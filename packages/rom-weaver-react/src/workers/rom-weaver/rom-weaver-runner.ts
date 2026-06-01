import type {
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverCommand,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunRequest,
} from "rom-weaver-wasm";
import { type BrowserVirtualFile, getActiveBrowserVirtualFiles } from "../protocol/browser-virtual-files.ts";
import { isBrowserRuntime } from "../shared/runtime-env.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import { getRomWeaverRunEventLabel, isRomWeaverFailedRunEvent } from "./rom-weaver-run-events.ts";

type RomWeaverRunnerRunJsonOptions = RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, RuntimeValue> &
  RomWeaverBrowserOpfsRunOptions;
type RomWeaverRunnerRunJsonResult = RomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

type RomWeaverWorkerClient = {
  init: (...args: unknown[]) => Promise<RomWeaverRunnerReadyMetadata>;
  dispose?: () => Promise<void>;
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
};

type BrowserWasmAssetSelection = {
  threadWorkerUrl?: string;
  wasmUrl?: string;
};

let browserWasmUrlPromise: Promise<string> | null = null;
let browserThreadWorkerUrlPromise: Promise<string> | null = null;
let browserThreadedRunnerPromise: Promise<RomWeaverRunner> | null = null;

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

const readRunCommand = (commandOrRequest: RomWeaverRunInput): RomWeaverCommand =>
  isRomWeaverRunRequest(commandOrRequest) ? commandOrRequest.command : commandOrRequest;

const pushPathValue = (out: Set<string>, value: unknown) => {
  if (typeof value !== "string") return;
  const path = value.trim();
  if (!path || path.startsWith("-")) return;
  out.add(path);
};

const pushPathValues = (out: Set<string>, value: unknown) => {
  if (Array.isArray(value)) {
    for (const entry of value) pushPathValue(out, entry);
    return;
  }
  pushPathValue(out, value);
};

const throwUnhandledRomWeaverCommand = (command: never): never => {
  throw new Error(`Unhandled rom-weaver command type: ${String((command as { type?: unknown }).type || "unknown")}`);
};

const collectReferencedVirtualFilePaths = (
  commandOrRequest: RomWeaverRunInput,
  options?: RomWeaverRunnerRunJsonOptions,
) => {
  const paths = new Set<string>();
  const command = readRunCommand(commandOrRequest);

  switch (command.type) {
    case "checksum":
    case "extract":
    case "inspect":
      pushPathValue(paths, command.args.source);
      break;
    case "compress":
      pushPathValues(paths, command.args.input);
      break;
    case "batch-header-fixer":
    case "trim":
      pushPathValues(paths, command.args.source);
      break;
    case "patch-apply":
      pushPathValue(paths, command.args.input);
      pushPathValues(paths, command.args.patches);
      break;
    case "patch-create":
      pushPathValue(paths, command.args.original);
      pushPathValue(paths, command.args.modified);
      break;
    default:
      throwUnhandledRomWeaverCommand(command);
  }

  pushPathValues(paths, options?.knownInputPaths);
  return paths;
};

const selectActiveVirtualFilesForRun = (
  activeVirtualFiles: BrowserVirtualFile[],
  commandOrRequest: RomWeaverRunInput,
  options?: RomWeaverRunnerRunJsonOptions,
) => {
  const command = readRunCommand(commandOrRequest);
  const referencedPaths = collectReferencedVirtualFilePaths(commandOrRequest, options);
  if (command.type === "compress" && [...referencedPaths].some((path) => /\.cue$/i.test(path))) {
    return activeVirtualFiles;
  }
  if (!referencedPaths.size) return activeVirtualFiles;
  return activeVirtualFiles.filter((file) => referencedPaths.has(file.path));
};

const readWasmUrlModuleDefault = (module: { default?: unknown }, fallback: string) => {
  const candidate = module.default;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return fallback;
};

const resolveBrowserWasmUrl = async () => {
  if (!browserWasmUrlPromise) {
    browserWasmUrlPromise = import("rom-weaver-wasm/rom-weaver-app.wasm?url")
      .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/rom-weaver-app.wasm"))
      .catch(() => "rom-weaver-wasm/rom-weaver-app.wasm");
  }
  return browserWasmUrlPromise;
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
    throw new Error("rom-weaver browser runtime requires SharedArrayBuffer and cross-origin isolation (COOP/COEP).");
  }
  const [wasmUrl, threadWorkerUrl] = await Promise.all([resolveBrowserWasmUrl(), resolveBrowserThreadWorkerUrl()]);
  return { threadWorkerUrl, wasmUrl };
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
    ...(wasmAsset.wasmUrl ? { wasmUrl: wasmAsset.wasmUrl } : {}),
    ...(wasmAsset.threadWorkerUrl ? { threadWorkerUrl: wasmAsset.threadWorkerUrl } : {}),
    ...(defaultThreads ? { defaultThreads } : {}),
    workGuestPath: WORKER_OPFS_MOUNTPOINT,
  };
};

const createBrowserRunner = async (options?: { workerThreads?: RuntimeValue }): Promise<RomWeaverRunner> => {
  const { createBrowserWorkerClient } = await import("rom-weaver-wasm/workers/browser-client");
  const client = createBrowserWorkerClient() as unknown as RomWeaverWorkerClient;
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
      await client.dispose?.().catch(() => undefined);
    },
    ready,
    runJson: (commandOrRequest, options) => client.runJson(commandOrRequest, options),
  };
};

const createRomWeaverRunner = async (options?: { workerThreads?: RuntimeValue }) => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  const workerThreads = options?.workerThreads;
  if (!browserThreadedRunnerPromise)
    browserThreadedRunnerPromise = createBrowserRunner({ workerThreads }).catch((error) => {
      browserThreadedRunnerPromise = null;
      throw error;
    });
  return browserThreadedRunnerPromise;
};

const resetRomWeaverRunner = async () => {
  const activeRunnerPromises = [browserThreadedRunnerPromise].filter(
    (entry): entry is Promise<RomWeaverRunner> => !!entry,
  );
  browserThreadedRunnerPromise = null;
  if (!activeRunnerPromises.length) return;
  const disposedRunners = new Set<RomWeaverRunner>();
  for (const activeRunnerPromise of activeRunnerPromises) {
    const runner = await activeRunnerPromise.catch(() => null);
    if (!runner || disposedRunners.has(runner)) continue;
    disposedRunners.add(runner);
    await runner.dispose?.().catch(() => undefined);
  }
};

const runRomWeaverJson = async (commandOrRequest: RomWeaverRunInput, options?: RomWeaverRunnerRunJsonOptions) => {
  const activeVirtualFiles = getActiveBrowserVirtualFiles();
  const scopedActiveVirtualFiles = selectActiveVirtualFilesForRun(activeVirtualFiles, commandOrRequest, options);
  const configuredVirtualFiles = options?.virtualFiles;
  const runOptionOverrides = { ...(options || {}) };
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
  emitRunnerTraceLine(
    options,
    `runJson preparing command=${formatCommandForTrace(commandOrRequest)} activeVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(activeVirtualFiles),
    )} scopedVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(scopedActiveVirtualFiles),
    )} configuredVirtualFiles=${Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles.length : 0} invalidateMountCacheAfterRun=${String(runOptions.invalidateMountCacheAfterRun)}`,
  );
  const runner = await createRomWeaverRunner();
  emitRunnerTraceLine(options, `runJson dispatch mode=${runner.ready.mode} threaded=${String(runner.ready.threaded)}`);
  return runner.runJson(commandOrRequest, runOptions);
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
  const command: RomWeaverCommand = isRomWeaverRunRequest(commandOrRequest)
    ? commandOrRequest.command
    : commandOrRequest;
  try {
    return JSON.stringify(command);
  } catch (_err) {
    return String(command.type || "unknown");
  }
};

const isRomWeaverRunRequest = (value: RomWeaverRunInput): value is RomWeaverRunRequest => {
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
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
};
