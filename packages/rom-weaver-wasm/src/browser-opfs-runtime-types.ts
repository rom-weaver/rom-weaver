import type { ThreadStartControl } from './browser-wasi-thread-protocol.ts';
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
} from './rom-weaver-types.d.ts';

export type AnyRecord = Record<string, any>;
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
    hostSelect?: (request: string) => number;
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
export type BrowserOpfsRuntimePayload = AnyRecord & {
  runtime?: BrowserOpfsRuntime;
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

export type ThreadPoolCommand = {
  commandId: number;
  debugWasi: boolean;
  envList: unknown;
  ready: Promise<void> | null;
  runtime: BrowserOpfsRuntime;
  shutdown: () => Promise<void>;
  slots: ThreadPoolCommandSlot[];
  streamBroadcastChannelName?: string;
  streamRequestId?: number;
  threadIdState: unknown;
  threadWorkerUrl: string;
  wasiArgs: unknown;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
};

export interface RomWeaverBrowserOpfsRunner {
  dispose(): Promise<void>;
  fs: null;
  mode: 'browser-opfs';
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
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverRunOutput,
  RomWeaverRunRequest,
};
