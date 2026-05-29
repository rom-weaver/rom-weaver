import type {
  Commands,
  CompressionLevelProfile,
  JsonValue,
  OperationFamily,
  OperationStatus,
  ProgressEvent,
  RomWeaverRunOutputOptions,
  RomWeaverRunRequest,
  ThreadBudget,
  ThreadExecution,
  ThreadMode,
} from './generated/rom-weaver-rust-types.d.ts';

export type RomWeaverDefaultThreads = number | string | false | null | undefined;
export type RomWeaverEnv = Record<string, string>;
export type {
  BatchHeaderFixerCommand,
  ChecksumCommand,
  Commands,
  CompressCommand,
  CompressionLevelProfile,
  ExtractCommand,
  InspectCommand,
  PatchApplyCommand,
  PatchCreateCommand,
  RomWeaverRunOutputOptions,
  RomWeaverRunRequest,
  ThreadBudget,
  TrimCommand,
} from './generated/rom-weaver-rust-types.d.ts';

export type RomWeaverCommand = Commands;
export type RomWeaverRunInput = RomWeaverCommand | RomWeaverRunRequest;
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

export interface RomWeaverInspectContainerDetails {
  entry_count: number | null;
  entries?: string[];
  recommended_compress_format?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface RomWeaverInspectPatchDetails {
  format: string | null;
  source_size: number | null;
  target_size: number | null;
  source_crc32: number | null;
  target_crc32: number | null;
  patch_crc32: number | null;
  record_count: number | null;
  [key: string]: unknown;
}

export interface RomWeaverProgressDetails {
  container?: RomWeaverInspectContainerDetails;
  patch?: RomWeaverInspectPatchDetails;
  [key: string]: unknown;
}

export type RomWeaverJsonValue = JsonValue;
export type RomWeaverOperationFamily = OperationFamily;
export type RomWeaverOperationStatus = OperationStatus;
export type RomWeaverThreadMode = ThreadMode;
export type RomWeaverThreadExecution = ThreadExecution;
export type RomWeaverProgressEvent = ProgressEvent;

export interface ParseJsonLinesOptions<TEvent = RomWeaverProgressEvent> {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
}

export interface ParseJsonLinesResult<TEvent = RomWeaverProgressEvent> {
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

export interface RomWeaverRunJsonOptions<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>
extends RomWeaverRunOptions {
  onEvent?: (event: TEvent) => void;
  onNonJsonLine?: (line: string) => void;
  onTraceEvent?: (event: TTraceEvent) => void;
  onTraceNonJsonLine?: (line: string) => void;
}

export interface RomWeaverRunJsonResult<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>
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

export type RomWeaverBrowserSyncAccessMode = 'read-only' | 'readwrite' | 'readwrite-unsafe';

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
  /** URL for the non-threaded wasm artifact. Defaults to the package artifact URL. */
  wasmUrl?: string;
  /** URL for the threaded wasm artifact. Defaults to the package artifact URL. */
  threadedWasmUrl?: string;
  /** Optional override for threaded selection; default behavior auto-selects by runtime capability. */
  preferThreadedWasm?: boolean;
  threadWorkerUrl?: string | URL;
  sharedMemoryInitialPages?: number;
  sharedMemoryMaximumPages?: number;
  opfsHandle?: FileSystemDirectoryHandleLike;
  /** Guest path for the single staged OPFS mount. Defaults to `/work`. */
  workGuestPath?: string;
  /** @deprecated Use workGuestPath. */
  opfsGuestPath?: string;
  runtimeMounts?: string[];
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  virtualFiles?: RomWeaverBrowserVirtualFile[];
  /** When true, mount tables start empty and only hydrated paths/virtual files are present. */
  virtualOnlyMounts?: boolean;
  /** Writable guest roots. Defaults to the work mount itself. */
  writableDirectories?: string[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  /** Number of preopened OPFS scratch files available for dynamically created WASI files. */
  scratchFilePoolSize?: number;
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
  /** When true, mount tables start empty and only hydrated paths/virtual files are present. */
  virtualOnlyMounts?: boolean;
  writableDirectories?: string[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  scratchFilePoolSize?: number;
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

export type RomWeaverWorkerErrorKind =
  | 'validation'
  | 'unknown_format'
  | 'unsupported'
  | 'cancelled'
  | 'io'
  | 'thread_pool_build'
  | 'worker'
  | 'panic'
  | 'unknown';

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
}

export interface RomWeaverWorkerError extends Error {
  kind: RomWeaverWorkerErrorKind;
  context?: RomWeaverWorkerErrorContext;
}
