import type { Worker, WorkerOptions } from 'node:worker_threads';
import type {
  RomWeaverNodeWorkerMode,
  RomWeaverProgressEvent,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
  RomWeaverWorkerError,
} from '../rom-weaver-types.d.ts';
import type { WorkerClientRunJsonOptions } from './worker-client-types.d.ts';

export interface NodeWorkerClientCreateOptions {
  worker?: Worker;
  workerUrl?: URL | string;
  workerOptions?: WorkerOptions;
}

export type NodeWorkerRunJsonOptions<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown> =
  WorkerClientRunJsonOptions<TEvent, TTraceEvent>;

export type NodeWorkerClientError = RomWeaverWorkerError;

export function createNodeWorkerClient(options?: NodeWorkerClientCreateOptions): NodeRomWeaverWorkerClient;

export class NodeRomWeaverWorkerClient {
  constructor(worker: Worker);
  init(mode?: RomWeaverNodeWorkerMode, options?: Record<string, unknown>): Promise<{ mode: string }>;
  run(args?: unknown[], options?: RomWeaverRunOptions & Record<string, unknown>): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverProgressEvent, TTraceEvent = unknown>(
    args?: unknown[],
    options?: NodeWorkerRunJsonOptions<TEvent, TTraceEvent>,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  dispose(): Promise<{ disposed: true }>;
  terminate(): Promise<void>;
}
