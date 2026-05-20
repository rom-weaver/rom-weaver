import { createWasmToolError } from "../../../shared/wasm-tool-runtime-utils.ts";
import { isBrowserMainThread } from "./browser-runtime.ts";
import { createSevenZipStderrProgressParser } from "./sevenzip-progress.ts";
import sevenZipZstdLoader from "./sevenzip-zstd-loader.ts";
import type {
  SevenZipFactoryLike,
  SevenZipFactoryOptions,
  SevenZipModuleLike,
  SevenZipOutputState,
  SevenZipRunResult,
} from "./types.ts";

const SEVEN_ZIP_RETRYABLE_ERROR_REGEX = /7-Zip \(z\)|7-Zip-zstd failed|RuntimeError|null function|abort|memory/i;
const ARCHIVE_ENTRY_NOT_FOUND_ERROR_REGEX = /^Archive entry not found:/i;
const UNSUPPORTED_ARCHIVE_ERROR_REGEX = /^Unsupported /i;

const BACKSPACE_CHARACTER = String.fromCharCode(8);

let sevenZipFactory: SevenZipFactoryLike | null = sevenZipZstdLoader as RuntimeValue as SevenZipFactoryLike;
let sevenZipPromise: Promise<SevenZipModuleLike> | null = null;
let sevenZipQueue: Promise<void> = Promise.resolve();
let sevenZipConfig: { threads: number | null } = { threads: null };

const assertNotBrowserMainThread = () => {
  if (isBrowserMainThread()) throw new Error("7-Zip-zstd wasm must run in a worker in browser environments");
};

export const normalizeThreadCount = (threads: string | number | boolean | null | undefined) => {
  if (threads === undefined || threads === null || threads === "" || threads === "auto") return null;
  const parsed = parseInt(String(threads), 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`Invalid 7-Zip-zstd thread count: ${threads}`);
  return Math.max(1, Math.min(64, parsed));
};

const getSevenZipFactoryOptions = () =>
  typeof sevenZipConfig.threads === "number" ? { workerThreads: sevenZipConfig.threads } : undefined;

const createSevenZipPromise = (factoryOptions?: SevenZipFactoryOptions) => {
  assertNotBrowserMainThread();
  const factory = sevenZipFactory;
  if (!factory) throw new Error("Rom Patcher JS: 7-Zip-zstd wasm not found");
  let outputState: SevenZipOutputState;
  const stderrProgressParser = createSevenZipStderrProgressParser((percent) => {
    if (typeof outputState.onStderrProgress === "function") outputState.onStderrProgress(percent);
  });
  outputState = {
    onStderrProgress: null,
    resetStderrProgress: () => stderrProgressParser.reset(),
    stderr: [],
    stdout: [],
  };
  const callerPreRun = factoryOptions?.preRun;
  const callerPreRuns = Array.isArray(callerPreRun) ? callerPreRun : [];
  if (callerPreRun && !Array.isArray(callerPreRun)) callerPreRuns.push(callerPreRun);
  const installStderrProgressHook = (moduleObject: SevenZipFactoryOptions) => {
    const FS = (moduleObject as RuntimeValue as SevenZipModuleLike)?.FS;
    if (FS && typeof FS.init === "function") FS.init(null, null, (value: number) => stderrProgressParser.push(value));
  };
  const moduleArg: SevenZipFactoryOptions = {
    ...(factoryOptions || {}),
    __romWeaverSevenZipZstdOutput: outputState,
    noExitRuntime: true,
    preRun: [...callerPreRuns, installStderrProgressHook as RuntimeValue],
    print: (line: RuntimeValue) => outputState.stdout.push(String(line)),
    printErr: (line: RuntimeValue) => {
      const text = String(line);
      stderrProgressParser.push(text);
      outputState.stderr.push(text);
    },
    wasmToolName: "7-Zip-zstd",
  };
  return Promise.resolve(factory(moduleArg)).then((module) => {
    module.__romWeaverSevenZipZstdOutput = outputState;
    return module;
  });
};

export const getSevenZip = () => {
  if (!sevenZipPromise) sevenZipPromise = createSevenZipPromise(getSevenZipFactoryOptions());
  return sevenZipPromise;
};

export const configureSevenZip = (options?: {
  sevenZipFactory?: SevenZipFactoryLike | null;
  threads?: string | number | boolean | null;
}) => {
  const nextThreads = normalizeThreadCount(options?.threads);
  const nextFactory =
    options && Object.hasOwn(options, "sevenZipFactory") ? options.sevenZipFactory || null : sevenZipFactory;
  if (nextThreads !== sevenZipConfig.threads || nextFactory !== sevenZipFactory) {
    sevenZipConfig = { threads: nextThreads };
    sevenZipFactory = nextFactory;
    sevenZipPromise = null;
  }
};

export const withSevenZip = <T>(callback: (sevenZip: SevenZipModuleLike) => Promise<T> | T): Promise<T> => {
  const run = sevenZipQueue.then(() => getSevenZip().then(callback));
  sevenZipQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const shouldRetryWithFreshSevenZip = (err: RuntimeValue) => {
  const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  if (ARCHIVE_ENTRY_NOT_FOUND_ERROR_REGEX.test(message)) return false;
  if (UNSUPPORTED_ARCHIVE_ERROR_REGEX.test(message)) return false;
  return SEVEN_ZIP_RETRYABLE_ERROR_REGEX.test(message);
};

export const withFreshSevenZipRetry = async <T>(
  callback: (sevenZip: SevenZipModuleLike) => Promise<T> | T,
): Promise<T> => {
  try {
    return await withSevenZip(callback);
  } catch (err) {
    if (!shouldRetryWithFreshSevenZip(err)) throw err;
    sevenZipPromise = null;
    return withSevenZip(callback);
  }
};

const cleanSevenZipOutput = (value: string) => value.replace(/\r/g, "\n").split(BACKSPACE_CHARACTER).join("");

export const runSevenZip = (sevenZip: SevenZipModuleLike, args: string[], cwd?: string): SevenZipRunResult => {
  const output = sevenZip.__romWeaverSevenZipZstdOutput || {
    stderr: [],
    stdout: [],
  };
  output.stderr.length = 0;
  output.stdout.length = 0;
  output.resetStderrProgress?.();

  const FS = sevenZip.FS;
  const previousCwd = cwd ? FS.cwd() : null;
  const previousExitCode =
    typeof process !== "undefined" && Object.hasOwn(process, "exitCode") ? process.exitCode : undefined;
  let status = 0;
  try {
    if (cwd) FS.chdir(cwd);
    const result = sevenZip.callMain(args.slice());
    status = typeof result === "number" ? result : 0;
  } catch (err) {
    const statusValue =
      err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : NaN;
    status = Number.isFinite(statusValue) ? statusValue : -1;
    if (status === -1) {
      throw createWasmToolError({
        argv: args,
        cause: err,
        fallbackMessage: "7-Zip-zstd failed",
        phase: "running command",
        status: null,
        tool: sevenZip as RuntimeValue as Parameters<typeof createWasmToolError>[0]["tool"],
      });
    }
  } finally {
    if (previousCwd) FS.chdir(previousCwd);
    if (typeof process !== "undefined") process.exitCode = previousExitCode;
  }

  const stdout = cleanSevenZipOutput(output.stdout.join("\n"));
  const stderr = cleanSevenZipOutput(output.stderr.join("\n"));
  if (status !== 0) {
    throw createWasmToolError({
      argv: args,
      fallbackMessage: "7-Zip-zstd failed",
      phase: "running command",
      status,
      stderr,
      stdout,
      tool: sevenZip as RuntimeValue as Parameters<typeof createWasmToolError>[0]["tool"],
    });
  }
  return { status, stderr, stdout };
};
