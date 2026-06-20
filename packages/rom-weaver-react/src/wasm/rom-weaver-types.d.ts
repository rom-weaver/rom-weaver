import type {
  CompressionLevelProfile,
  JsonValue,
  OperationFamily,
  OperationStatus,
  RomWeaverCommand,
  RomWeaverErrorKind,
  RomWeaverRunJsonEvent,
  RomWeaverRunOutputOptions,
  RomWeaverRunRequest,
  ThreadBudget,
  ThreadExecution,
  ThreadMode,
} from "./generated/rom-weaver-rust-types.d.ts";

export type RomWeaverDefaultThreads = number | string | false | null | undefined;
export type RomWeaverEnv = Record<string, string>;
export type {
  ChecksumCommand,
  Commands,
  CompressCommand,
  CompressionLevelProfile,
  ExtractCommand,
  ExtractedFileEntry,
  ExtractStepDetails,
  ListCommand,
  PatchApplyCommand,
  PatchCommands,
  PatchCreateCandidatesCommand,
  PatchCreateCommand,
  PatchValidateCommand,
  ProbeCommand,
  RomWeaverCommand,
  RomWeaverProgressEvent,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunOutputOptions,
  RomWeaverRunRequest,
  ThreadBudget,
  TrimCommand,
} from "./generated/rom-weaver-rust-types.d.ts";

export type RomWeaverCompressionLevelProfile = CompressionLevelProfile;
export type RomWeaverThreadBudget = ThreadBudget;
export type RomWeaverRunOutput = RomWeaverRunOutputOptions;

export interface RomWeaverRunResult {
  command: RomWeaverCommand;
  request: RomWeaverRunRequest;
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  error?: unknown;
}

export interface RomWeaverRunOptions {
  /**
   * Process environment variables forwarded to the wasm runtime.
   * Browser runners may set safety defaults.
   */
  env?: RomWeaverEnv;
  /** Emit JSON progress events to stdout. runJson sets this automatically. */
  json?: boolean;
  /** Override progress event emission. Defaults to JSON mode or terminal stdout. */
  progress?: boolean;
  /** Emit trace events to stderr. */
  trace?: boolean;
  /** Enable interactive selection if a command can ask for one. */
  interactiveSelectionEnabled?: boolean;
  /** Rust-wire spelling for interactiveSelectionEnabled. */
  interactive_selection_enabled?: boolean;
}

export interface RomWeaverProbeContainerDetails {
  entry_count: number | null;
  entries?: string[];
  recommended_compress_format?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface RomWeaverProbePatchDetails {
  format: string | null;
  minimum_source_size: number | null;
  source_size: number | null;
  target_size: number | null;
  source_crc32: number | null;
  target_crc32: number | null;
  patch_crc32: number | null;
  record_count: number | null;
  source_window_count: number | null;
  target_window_count: number | null;
  window_checksum_count: number | null;
  [key: string]: unknown;
}

export interface RomWeaverProgressDetails {
  container?: RomWeaverProbeContainerDetails;
  patch?: RomWeaverProbePatchDetails;
  [key: string]: unknown;
}

export type RomWeaverJsonValue = JsonValue;
export type RomWeaverOperationFamily = OperationFamily;
export type RomWeaverOperationStatus = OperationStatus;
export type RomWeaverThreadMode = ThreadMode;
export type RomWeaverThreadExecution = ThreadExecution;

export interface ParseJsonLinesOptions<TEvent = RomWeaverRunJsonEvent> {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
}

export interface ParseJsonLinesResult<TEvent = RomWeaverRunJsonEvent> {
  events: TEvent[];
  nonJsonLines: string[];
}

export interface ParseTraceJsonLinesOptions<TTraceEvent = unknown> {
  onTraceEvent?: (event: TTraceEvent) => void;
  onTraceNonJsonLine?: (line: string) => void;
}

export interface ParseTraceJsonLinesResult<TTraceEvent = unknown> {
  traceEvents: TTraceEvent[];
  traceNonJsonLines: string[];
}

export interface RomWeaverRunJsonOptions<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>
  extends RomWeaverRunOptions {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
  onTraceEvent?: (event: TTraceEvent) => void;
  onTraceNonJsonLine?: (line: string) => void;
}

export interface RomWeaverRunJsonResult<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>
  extends RomWeaverRunResult {
  events: TEvent[];
  nonJsonLines: string[];
  traceEvents: TTraceEvent[];
  traceNonJsonLines: string[];
}

export interface FileSystemDirectoryHandleLike {
  kind: string;
  entries: () => AsyncIterable<[string, unknown]>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<unknown>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<unknown>;
  removeEntry?: (name: string, options?: { recursive?: boolean }) => Promise<void>;
}

export type RomWeaverBrowserSyncAccessMode = "read-only" | "readwrite" | "readwrite-unsafe";

export interface RomWeaverBrowserVirtualFile {
  path: string;
  proxy?: {
    id: string;
    maxChunkSize?: number;
    size: number;
    slots: Array<{
      controlBuffer: SharedArrayBuffer;
      dataBuffer: SharedArrayBuffer;
    }>;
  };
  source?: Blob | Uint8Array | ArrayBuffer;
  file?: Blob;
  blob?: Blob;
  bytes?: Uint8Array | ArrayBuffer;
  data?: Uint8Array | ArrayBuffer;
}

export interface RomWeaverBrowserOpfsOptions {
  module?: WebAssembly.Module;
  /** URL for the wasm artifact. Defaults to the package artifact URL. */
  wasmUrl?: string;
  threadWorkerUrl?: string | URL;
  /** URL for the bundled OPFS proxy worker. Defaults to the package artifact URL. Required in a
   * production build, where the `new URL(...)` dev fallback would resolve to an unbundled source file. */
  opfsProxyWorkerUrl?: string | URL;
  sharedMemoryInitialPages?: number;
  /** Exact shared-memory maximum. Omit to allow the browser runtime's default fallback ladder. */
  sharedMemoryMaximumPages?: number;
  opfsHandle?: FileSystemDirectoryHandleLike;
  /** Guest path for the single staged OPFS mount. Defaults to `/work`. */
  workGuestPath?: string;
  /** @deprecated Use workGuestPath. */
  opfsGuestPath?: string;
  runtimeMounts?: string[];
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  virtualFiles?: RomWeaverBrowserVirtualFile[];
  /** Extra guest input paths that threaded virtual-only mounts must hydrate before a run. */
  knownInputPaths?: string[];
  /** Writable guest output paths to create/truncate inside the cached OPFS mount before a run. */
  preopenOutputPaths?: string[];
  /** When true, mount tables start empty and only hydrated paths/virtual files are present. */
  virtualOnlyMounts?: boolean;
  /** Writable guest roots. Defaults to the work mount itself. */
  writableDirectories?: string[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  /**
   * Default browser thread count applied for typed threaded commands when no
   * command-level thread budget is provided. Use null, false, 0, or "off" to
   * leave the request unchanged.
   */
  defaultThreads?: RomWeaverDefaultThreads;
  program?: string;
  argv0?: string;
  /** Base environment for every browser run. */
  env?: RomWeaverEnv;
  debugWasi?: boolean;
}

export interface RomWeaverBrowserOpfsRunOptions extends RomWeaverRunOptions {
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  virtualFiles?: RomWeaverBrowserVirtualFile[];
  /**
   * How long this command's OPFS inputs took to stage (ms), recorded on the main thread by
   * createBrowserOpfsSourceRef and forwarded so the runner can print it on the [perf] command timings
   * line. 0 means the input was already on OPFS; omitted when nothing referenced was staged (e.g.
   * virtual-Blob inputs).
   */
  stagingMs?: number;
  /** Extra guest input paths that threaded virtual-only mounts must hydrate before a run. */
  knownInputPaths?: string[];
  /** Writable guest output paths to create/truncate inside the cached OPFS mount before a run. */
  preopenOutputPaths?: string[];
  /** When true, mount tables start empty and only hydrated paths/virtual files are present. */
  virtualOnlyMounts?: boolean;
  writableDirectories?: string[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  invalidateMountCacheBeforeRun?: boolean;
  invalidateMountCacheAfterRun?: boolean;
  threadWorkerUrl?: string | URL;
  /**
   * Per-run default browser thread count applied for typed threaded commands
   * when no command-level thread budget is provided. Use null, false, 0, or
   * "off" to leave the request unchanged.
   */
  defaultThreads?: RomWeaverDefaultThreads;
  program?: string;
  debugWasi?: boolean;
}

/** Re-exported from the generated Rust types so the worker-error layer can
 * source the core kinds (and a compile-time exhaustiveness guard) from the same
 * single source of truth as `RomWeaverWorkerErrorKind`. */
export type { RomWeaverErrorKind } from "./generated/rom-weaver-rust-types.d.ts";

/**
 * Worker-error classification surfaced to the webapp. The core kinds are
 * sourced from the generated {@link RomWeaverErrorKind} (one per
 * `RomWeaverError` bucket); `worker`, `panic`, and `unknown` are
 * JS-transport-only kinds with no Rust variant. A future Rust kind widens this
 * union automatically; the compile-time guard in worker-error-utils.ts forces
 * the runtime `WORKER_ERROR_KINDS` set to keep up.
 */
export type RomWeaverWorkerErrorKind = RomWeaverErrorKind | "worker" | "panic" | "unknown";

export interface RomWeaverWorkerErrorContext {
  command?: string;
  family?: string;
  format?: string | null;
  stage?: string;
}

export interface RomWeaverWorkerSerializedError {
  name: string;
  message: string;
  stack?: string;
  kind?: RomWeaverWorkerErrorKind;
  context?: RomWeaverWorkerErrorContext;
  cause?: RomWeaverWorkerSerializedError | string;
}

export interface RomWeaverWorkerError extends Error {
  kind: RomWeaverWorkerErrorKind;
  context?: RomWeaverWorkerErrorContext;
}
