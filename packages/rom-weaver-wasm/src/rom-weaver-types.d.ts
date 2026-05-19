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

export interface RomWeaverWasiRunnerOptions {
  wasmPath?: string;
  argv0?: string;
  env?: RomWeaverEnv;
  preopens?: RomWeaverPreopens;
  useDefaultPreopens?: boolean;
}

export interface NodeFsRunnerOptions extends RomWeaverWasiRunnerOptions {
  includeHostRoot?: boolean;
  mountCwd?: boolean;
  cwdGuestPath?: string;
  mountTmp?: boolean;
  tmpGuestPath?: string;
  tmpHostPath?: string;
  mounts?: Record<string, string>;
}

export interface FileSystemDirectoryHandleLike {
  kind: string;
  entries: () => AsyncIterable<[string, unknown]>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<unknown>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<unknown>;
}

export type RomWeaverBrowserSyncAccessMode = 'read-only' | 'readwrite' | 'readwrite-unsafe';

export interface RomWeaverZenFsNodeOptions extends NodeFsRunnerOptions {
  cwdHostPath?: string;
}

export interface RomWeaverZenFsBrowserOptions {
  module?: WebAssembly.Module;
  wasmUrl?: string;
  opfsHandle?: FileSystemDirectoryHandleLike;
  opfsGuestPath?: string;
  tmpGuestPath?: string;
  runtimeMounts?: string[];
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  program?: string;
  argv0?: string;
  env?: RomWeaverEnv;
  debugWasi?: boolean;
}

export interface RomWeaverZenFsBrowserRunOptions extends RomWeaverRunOptions {
  mountHandles?: Record<string, FileSystemDirectoryHandleLike>;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  program?: string;
  debugWasi?: boolean;
}

export type RomWeaverNodeWorkerMode = 'wasi' | 'nodefs' | 'zenfs-node';

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
