import type { ThreadStartControl } from "./browser-wasi-thread-protocol.ts";
import type {
  FileSystemDirectoryHandleLike,
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOutput,
  RomWeaverRunRequest,
  RomWeaverRunResult,
} from "./rom-weaver-types.d.ts";

export type LineHandler = (line: string) => void;
export type TraceLine = (line: string) => void;
export type FileReaderSyncLike = {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
};

export type BrowserOpfsCreateOptions = RomWeaverBrowserOpfsOptions & {
  threadScratchFilePoolSize?: number;
};
export type BrowserOpfsRunOptions = RomWeaverBrowserOpfsRunOptions &
  RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, unknown> & {
    __streamBroadcastChannelName?: string;
    __streamRequestId?: number;
    onStderrLine?: LineHandler;
    onStdoutLine?: LineHandler;
    // Resolve a mid-run selection request to the chosen 0-based indices (empty == cancel). Single-
    // select prompts use the first index; multi-select prompts use all of them.
    hostSelect?: (request: string) => number[];
    preopenOutputPaths?: string[];
    threadScratchFilePoolSize?: number;
  };
export type BrowserOpfsRuntime = Partial<BrowserOpfsRunOptions> & {
  cwdMountPath?: string;
  debugWasi?: boolean;
  envList?: string[];
  invalidateMountCacheAfterRun?: boolean;
  invalidateMountCacheBeforeRun?: boolean;
  knownInputPaths?: string[];
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  preopenOutputPaths?: string[];
  request?: RomWeaverRunRequest;
  runtimeMounts?: string[];
  scratchFilePoolSize?: number;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  threadScratchFilePoolSize?: number;
  virtualFiles?: unknown[];
  virtualOnlyMounts?: boolean;
  writableRoots?: string[];
};

export type WasiStartInstance = WebAssembly.Instance & {
  exports: WebAssembly.Exports & {
    memory: WebAssembly.Memory;
    _start: () => unknown;
  };
};

export type WasiThreadInstance = WebAssembly.Instance & {
  exports: WebAssembly.Exports & {
    memory: WebAssembly.Memory;
    wasi_thread_start?: (tid: number, startArg: number) => unknown;
  };
};

export type ThreadWorkerSlot = {
  busy: boolean;
  control: ThreadStartControl;
  failure: Error | null;
  index: number | string;
  tid: number | null;
  worker: Worker | null;
};

export type ThreadPoolShell = {
  currentCommand: ThreadPoolCommandSlot | null;
  index: number;
  online: boolean;
  ready: Promise<void> | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  rejectReady: ((error: unknown) => void) | null;
  resolveReady: (() => void) | null;
  terminated: boolean;
  /** Trace sink captured at creation so async ready/failure handlers can log this shell's lifecycle. */
  trace: ((message: string) => void) | null;
  worker: Worker | null;
};

export type ThreadPoolCommandSlot = ThreadWorkerSlot & {
  commandId: number;
  done: Promise<void> | null;
  online: boolean;
  ready: Promise<void> | null;
  readyResolved: boolean;
  rejectReady: ((error: unknown) => void) | null;
  resolveDone: (() => void) | null;
  resolveReady: (() => void) | null;
  shell: ThreadPoolShell;
};

export interface RomWeaverBrowserOpfsRunner {
  dispose(): Promise<void>;
  fs: null;
  mode: "browser-opfs";
  opfsGuestPath: string;
  opfsHandle: unknown;
  run(commandOrRequest: RomWeaverRunInput, options?: RomWeaverBrowserOpfsRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunJsonOptions<TEvent, TTraceEvent> & RomWeaverBrowserOpfsRunOptions,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  runtimeMounts: string[];
  threaded: boolean;
  wasmUrl: string | null;
  workGuestPath: string;
  writableRoots: string[];
}

export type {
  FileSystemDirectoryHandleLike,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOutput,
  RomWeaverRunRequest,
  RomWeaverRunResult,
};
