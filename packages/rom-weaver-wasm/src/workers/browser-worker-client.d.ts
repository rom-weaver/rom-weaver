import type {
  RomWeaverProgressEvent,
  RomWeaverDefaultThreads,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
  RomWeaverWorkerError,
} from '../rom-weaver-types.d.ts';
import type { WorkerClientRunJsonOptions } from './worker-client-types.d.ts';

export interface BrowserWorkerClientCreateOptions {
  defaultThreads?: RomWeaverDefaultThreads;
  worker?: Worker;
  workerUrl?: URL | string;
  workerOptions?: WorkerOptions;
}

export type BrowserWorkerRunJsonOptions<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown> =
  WorkerClientRunJsonOptions<TEvent, TTraceEvent>;

export type BrowserWorkerClientError = RomWeaverWorkerError;

export interface BrowserWorkerReady {
  mode: string;
  threaded: boolean;
  wasmUrl: string | null;
}

export function createBrowserWorkerClient(
  options?: BrowserWorkerClientCreateOptions,
): BrowserRomWeaverWorkerClient;

export class BrowserRomWeaverWorkerClient {
  constructor(worker: Worker, options?: { defaultThreads?: RomWeaverDefaultThreads });
  init(options?: Record<string, unknown>): Promise<BrowserWorkerReady>;
  run(args?: unknown[], options?: RomWeaverRunOptions & Record<string, unknown>): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>(
    args?: unknown[],
    options?: BrowserWorkerRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  dispose(): Promise<{ disposed: true }>;
  terminate(): void;
}
