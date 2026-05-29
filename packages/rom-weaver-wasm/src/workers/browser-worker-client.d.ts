import type {
  RomWeaverProgressEvent,
  RomWeaverDefaultThreads,
  RomWeaverRunInput,
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
  fallbackReason?: 'structured-clone';
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
  run(commandOrRequest: RomWeaverRunInput, options?: RomWeaverRunOptions & Record<string, unknown>): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>(
    commandOrRequest: RomWeaverRunInput,
    options?: BrowserWorkerRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  dispose(): Promise<{ disposed: true }>;
  terminate(): void;
}
