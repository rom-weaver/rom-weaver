import type {
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverDefaultThreads,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
} from "../rom-weaver-types.d.ts";
import { normalizeDefaultThreads, resolveBrowserDefaultThreads } from "./browser-thread-budget.ts";
import { createBrowserWorkerTransport, RomWeaverWorkerClientCore } from "./worker-client-core.ts";

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

export function createBrowserWorkerClient(options: BrowserWorkerClientOptions = {}) {
  options = options ?? {};
  const createWorker = () =>
    options.worker ??
    new Worker(options.workerUrl ?? new URL("./browser-runner-worker.ts", import.meta.url), {
      type: "module",
      ...(options.workerOptions ?? {}),
    });

  return new BrowserRomWeaverWorkerClient(createWorker(), {
    defaultThreads: Object.hasOwn(options, "defaultThreads") ? options.defaultThreads : resolveBrowserDefaultThreads(),
  });
}

const BROWSER_WORKER_TRANSPORT = createBrowserWorkerTransport();

export class BrowserRomWeaverWorkerClient extends RomWeaverWorkerClientCore {
  private _defaultThreads: number | null;

  constructor(worker: Worker, options: Pick<BrowserWorkerClientOptions, "defaultThreads"> = {}) {
    options = options ?? {};
    super(worker, BROWSER_WORKER_TRANSPORT);
    this._defaultThreads = normalizeDefaultThreads(options.defaultThreads);
  }

  async init(options: RomWeaverBrowserOpfsOptions = {}): Promise<BrowserWorkerReadyResult> {
    options = options ?? {};
    const initOptions = this._createInitOptions(options);
    return this._sendInit(initOptions);
  }

  override async run(
    commandOrRequest: RomWeaverRunInput,
    options: RomWeaverBrowserOpfsRunOptions = {},
  ): Promise<RomWeaverRunResult> {
    return super.run(commandOrRequest, options);
  }

  override async runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
    commandOrRequest: RomWeaverRunInput,
    options: RomWeaverRunJsonOptions<TEvent, TTraceEvent> & RomWeaverBrowserOpfsRunOptions = {},
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>> {
    return super.runJson(commandOrRequest, options);
  }

  _createInitOptions(options: RomWeaverBrowserOpfsOptions) {
    const initOptions = { ...options };
    if (!Object.hasOwn(initOptions, "defaultThreads") && this._defaultThreads !== null) {
      initOptions.defaultThreads = this._defaultThreads;
    }
    return initOptions;
  }

  _sendInit(options: RomWeaverBrowserOpfsOptions): Promise<BrowserWorkerReadyResult> {
    return this._send<BrowserWorkerReadyResult>({
      mode: "browser-opfs",
      options,
      type: "init",
    });
  }

  terminate() {
    this._shutdown("worker terminated");
    this._terminateWorker();
  }
}
