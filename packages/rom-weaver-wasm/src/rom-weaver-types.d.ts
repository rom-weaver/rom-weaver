export type RomWeaverArg = string | number | boolean | bigint;
export type RomWeaverEnv = Record<string, string>;
export type RomWeaverPreopens = Record<string, string>;

export type RomWeaverStdinInput = string | Uint8Array | ArrayBuffer | null | undefined;

export interface RomWeaverRunResult {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  error?: unknown;
}

export interface RomWeaverRunOptions {
  stdin?: RomWeaverStdinInput;
  /**
   * Process environment variables forwarded to the wasm runtime.
   * Browser runners may set safety defaults.
   */
  env?: RomWeaverEnv;
  preopens?: RomWeaverPreopens;
  argv0?: string;
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

export interface RomWeaverProgressEvent {
  command: string;
  family: string;
  format: string | null;
  stage: string;
  label: string;
  details: RomWeaverProgressDetails | null;
  percent: number | null;
  requested_threads: number | null;
  effective_threads: number | null;
  thread_mode: string | null;
  used_parallelism: boolean | null;
  thread_fallback: boolean | null;
  status: string;
}

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

export interface RomWeaverZenFsBrowserOptions {
  module?: WebAssembly.Module;
  wasmUrl?: string;
  opfsHandle?: FileSystemDirectoryHandleLike;
  scratchHandle?: FileSystemDirectoryHandleLike;
  /** Guest path for staged OPFS content. Defaults to `/work`. */
  opfsGuestPath?: string;
  /** Guest scratch path for temporary files. Defaults to `/scratch`. */
  scratchGuestPath?: string;
  /** @deprecated Use scratchGuestPath. */
  tmpGuestPath?: string;
  runtimeMounts?: string[];
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  /**
   * Mounts that should open files as writable during WASI execution.
   * This only affects pre-prepared files; dynamic path creation stays unsupported.
   */
  writableMounts?: string[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  program?: string;
  argv0?: string;
  /**
   * Base environment for every browser run.
   * If `ROM_WEAVER_MAX_BUFFERED_PATCH_BYTES` is unset, the runner defaults it to `67108864`.
   */
  env?: RomWeaverEnv;
  debugWasi?: boolean;
}

export interface RomWeaverZenFsBrowserRunOptions extends RomWeaverRunOptions {
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  writableMounts?: string[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
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
