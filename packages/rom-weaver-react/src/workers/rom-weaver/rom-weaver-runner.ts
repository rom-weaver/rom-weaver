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
  threadedWasmUrl: string;
  wasmUrl: string;
};

let browserWasmAssetPromise: Promise<BrowserWasmAssetSelection> | null = null;
let browserRunnerPromise: Promise<RomWeaverRunner> | null = null;

const normalizeArgs = (args: string[]) => args.map((value) => String(value));

const readWasmUrlModuleDefault = (module: { default?: unknown }, fallback: string) => {
  const candidate = module.default;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return fallback;
};

const resolveBrowserWasmAsset = async () => {
  if (!browserWasmAssetPromise) {
    browserWasmAssetPromise = Promise.all([
      import("rom-weaver-wasm/rom-weaver-cli.wasm?url")
        .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/rom-weaver-cli.wasm"))
        .catch(() => "rom-weaver-wasm/rom-weaver-cli.wasm"),
      import("rom-weaver-wasm/rom-weaver-cli-threaded.wasm?url")
        .then((module) => readWasmUrlModuleDefault(module, "rom-weaver-wasm/rom-weaver-cli-threaded.wasm"))
        .catch(() => "rom-weaver-wasm/rom-weaver-cli-threaded.wasm"),
    ])
      .then((module) => {
        const [wasmUrl, threadedWasmUrl] = module;
        return { threadedWasmUrl, wasmUrl };
      })
      .catch(() => ({
        threadedWasmUrl: "rom-weaver-wasm/rom-weaver-cli-threaded.wasm",
        wasmUrl: "rom-weaver-wasm/rom-weaver-cli.wasm",
      }));
  }
  return browserWasmAssetPromise;
};

const createBrowserRunner = async (): Promise<RomWeaverRunner> => {
  const { createBrowserWorkerClient } = await import("rom-weaver-wasm/workers/browser-client");
  const client = createBrowserWorkerClient() as unknown as RomWeaverWorkerClient;
  const wasmAsset = await resolveBrowserWasmAsset();
  const ready = await client.init({
    runtimeMounts: [WORKER_OPFS_MOUNTPOINT],
    threadedWasmUrl: wasmAsset.threadedWasmUrl,
    wasmUrl: wasmAsset.wasmUrl,
    workGuestPath: WORKER_OPFS_MOUNTPOINT,
  });
  const selectedWasmUrl = ready.threaded ? wasmAsset.threadedWasmUrl : wasmAsset.wasmUrl;
  publishRomWeaverWasmDiagnostic({
    context: "rom-weaver browser runner",
    contextUrl: selectedWasmUrl,
    reason: ready.threaded ? "cross-origin isolated" : "single-thread fallback",
    threaded: ready.threaded,
    url: ready.wasmUrl || selectedWasmUrl,
  });
  return {
    dispose: async () => {
      await client.dispose?.().catch(() => undefined);
    },
    ready,
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
  const runner = await createRomWeaverRunner();
  return runner.runJson(args, options);
};

const warmupRomWeaverRunner = async () => {
  return (await createRomWeaverRunner()).ready;
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

  const traceNonJsonLines = Array.isArray(result?.traceNonJsonLines) ? result.traceNonJsonLines : [];
  for (let index = traceNonJsonLines.length - 1; index >= 0; index -= 1) {
    const line = String(traceNonJsonLines[index] || "").trim();
    if (line) return line;
  }

  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (stderr) return stderr;

  const errorMessage = getErrorMessage((result as { error?: unknown } | null | undefined)?.error);
  if (errorMessage) return errorMessage;

  return fallback;
};

export type { RomWeaverRunJsonEvent, RomWeaverRunJsonOptions, RomWeaverRunJsonResult };
export {
  getRomWeaverFailureMessage,
  getRomWeaverRunnerMetadata,
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
};
