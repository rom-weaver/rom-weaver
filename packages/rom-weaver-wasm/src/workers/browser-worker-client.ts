import {
  createBrowserWorkerTransport,
  RomWeaverWorkerClientCore,
} from './worker-client-core.ts';
import type {
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverDefaultThreads,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
} from '../rom-weaver-types.d.ts';

type BrowserWorkerClientOptions = {
  defaultThreads?: RomWeaverDefaultThreads;
  worker?: Worker;
  workerOptions?: WorkerOptions;
  workerUrl?: string | URL;
};

type BrowserWorkerReadyResult = {
  mode: string;
  threaded: boolean;
  wasmUrl: string | null;
};

const DEFAULT_BROWSER_THREAD_COUNT = 4;
const MAX_BROWSER_THREAD_COUNT = 64;

export function createBrowserWorkerClient(options: BrowserWorkerClientOptions = {}) {
  options = options ?? {};
  const createWorker = () => (
    options.worker ?? new Worker(
      options.workerUrl ?? new URL('./browser-runner-worker.ts', import.meta.url),
      {
        type: 'module',
        ...(options.workerOptions ?? {}),
      },
    )
  );

  return new BrowserRomWeaverWorkerClient(createWorker(), {
    defaultThreads: Object.hasOwn(options, 'defaultThreads')
      ? options.defaultThreads
      : resolveBrowserDefaultThreads(),
  });
}

const BROWSER_WORKER_TRANSPORT = createBrowserWorkerTransport();

export class BrowserRomWeaverWorkerClient extends RomWeaverWorkerClientCore {
  private _defaultThreads: number | null;

  constructor(worker: Worker, options: Pick<BrowserWorkerClientOptions, 'defaultThreads'> = {}) {
    options = options ?? {};
    super(worker, BROWSER_WORKER_TRANSPORT);
    this._defaultThreads = normalizeDefaultThreads(options.defaultThreads);
  }

  async init(options: RomWeaverBrowserOpfsOptions = {}): Promise<BrowserWorkerReadyResult> {
    options = options ?? {};
    const initOptions = this._createInitOptions(options);
    return this._sendInit(initOptions);
  }

  override async run(commandOrRequest: RomWeaverRunInput, options: RomWeaverBrowserOpfsRunOptions = {}): Promise<RomWeaverRunResult> {
    return super.run(commandOrRequest, options as RomWeaverBrowserOpfsRunOptions & Record<string, unknown>);
  }

  override async runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
    commandOrRequest: RomWeaverRunInput,
    options: RomWeaverRunJsonOptions<TEvent, TTraceEvent> & RomWeaverBrowserOpfsRunOptions = {},
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>> {
    return super.runJson(
      commandOrRequest,
      options as RomWeaverRunJsonOptions<TEvent, TTraceEvent> & Record<string, unknown>,
    );
  }

  _createInitOptions(options: RomWeaverBrowserOpfsOptions) {
    const initOptions = { ...options };
    if (!Object.hasOwn(initOptions, 'defaultThreads') && this._defaultThreads !== null) {
      initOptions.defaultThreads = this._defaultThreads;
    }
    return initOptions;
  }

  _sendInit(options: RomWeaverBrowserOpfsOptions): Promise<BrowserWorkerReadyResult> {
    return this._send<BrowserWorkerReadyResult>({
      type: 'init',
      mode: 'browser-opfs',
      options: options as Record<string, unknown>,
    });
  }

  terminate() {
    this._shutdown('worker terminated');
    this._terminateWorker();
  }
}

function resolveBrowserDefaultThreads(root: typeof globalThis = globalThis) {
  const hardwareConcurrency = Number(root?.navigator?.hardwareConcurrency);
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0) {
    return Math.max(1, Math.min(DEFAULT_BROWSER_THREAD_COUNT, Math.floor(hardwareConcurrency)));
  }
  return DEFAULT_BROWSER_THREAD_COUNT;
}

function normalizeDefaultThreads(value: RomWeaverDefaultThreads) {
  if (
    value === undefined
    || value === null
    || value === false
    || value === 0
    || value === '0'
    || value === 'off'
  ) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`defaultThreads must be a positive integer; received: ${value}`);
  }
  return Math.max(1, Math.min(MAX_BROWSER_THREAD_COUNT, parsed));
}
