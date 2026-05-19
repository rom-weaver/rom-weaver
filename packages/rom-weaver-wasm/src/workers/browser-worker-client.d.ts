import type {
  RomWeaverProgressEvent,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
  RomWeaverWorkerError,
} from '../rom-weaver-types.d.ts';
import type { WorkerClientRunJsonOptions } from './worker-client-types.d.ts';

export interface BrowserWorkerClientCreateOptions {
  worker?: Worker;
  workerUrl?: URL | string;
  workerOptions?: WorkerOptions;
}

export type BrowserWorkerRunJsonOptions<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown> =
  WorkerClientRunJsonOptions<TEvent, TTraceEvent>;

export type BrowserWorkerClientError = RomWeaverWorkerError;

export function createBrowserWorkerClient(
  options?: BrowserWorkerClientCreateOptions,
): BrowserRomWeaverWorkerClient;

export class BrowserRomWeaverWorkerClient {
  constructor(worker: Worker);
  init(options?: Record<string, unknown>): Promise<{ mode: string }>;
  run(args?: unknown[], options?: RomWeaverRunOptions & Record<string, unknown>): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>(
    args?: unknown[],
    options?: BrowserWorkerRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  dispose(): Promise<{ disposed: true }>;
  terminate(): void;
}
