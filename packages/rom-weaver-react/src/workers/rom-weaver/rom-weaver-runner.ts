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
  init: (...args: unknown[]) => Promise<unknown>;
  dispose?: () => Promise<void>;
  runJson: (args?: unknown[], options?: RomWeaverRunJsonOptions) => Promise<RomWeaverRunJsonResult>;
};

type RomWeaverRunner = {
  dispose?: () => Promise<void>;
  runJson: (args: string[], options?: RomWeaverRunJsonOptions) => Promise<RomWeaverRunJsonResult>;
};

let browserWasmUrlPromise: Promise<string> | null = null;
let browserRunnerPromise: Promise<RomWeaverRunner> | null = null;

const normalizeArgs = (args: string[]) => args.map((value) => String(value));

const resolveBrowserWasmUrl = async () => {
  if (!browserWasmUrlPromise) {
    browserWasmUrlPromise = import("rom-weaver-wasm/rom-weaver-cli.wasm?url")
      .then((module) => {
        const candidate = (module as { default?: unknown }).default;
        if (typeof candidate === "string" && candidate.trim()) return candidate;
        return "rom-weaver-wasm/rom-weaver-cli.wasm";
      })
      .catch(() => "rom-weaver-wasm/rom-weaver-cli.wasm");
  }
  return browserWasmUrlPromise;
};

const createBrowserRunner = async (): Promise<RomWeaverRunner> => {
  const { createBrowserWorkerClient } = await import("rom-weaver-wasm/workers/browser-client");
  const client = createBrowserWorkerClient() as unknown as RomWeaverWorkerClient;
  const wasmUrl = await resolveBrowserWasmUrl();
  await client.init({
    opfsGuestPath: WORKER_OPFS_MOUNTPOINT,
    runtimeMounts: [WORKER_OPFS_MOUNTPOINT],
    scratchGuestPath: WORKER_OPFS_MOUNTPOINT,
    wasmUrl,
  });
  return {
    dispose: async () => {
      await client.dispose?.().catch(() => undefined);
    },
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
  await createRomWeaverRunner();
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
export { getRomWeaverFailureMessage, resetRomWeaverRunner, runRomWeaverJson, warmupRomWeaverRunner };
