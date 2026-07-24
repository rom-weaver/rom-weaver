import type { RomWeaverBrowserOpfsOptions, RomWeaverDefaultThreads } from "../rom-weaver-types.d.ts";
import { normalizeDefaultThreads, resolveBrowserDefaultThreads } from "./browser-thread-budget.ts";
import { createBrowserWorkerTransport, RomWeaverWorkerClientCore } from "./worker-client-core.ts";
// `?worker&url`, never `new URL(..., import.meta.url)` - see "Worker URLs" in docs/ARCHITECTURE.md.
import DEFAULT_RUNNER_WORKER_URL from "./browser-runner-worker.ts?worker&url";

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
    new Worker(options.workerUrl ?? DEFAULT_RUNNER_WORKER_URL, {
      type: "module",
      ...options.workerOptions,
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
