import {
  acknowledgeOpfsShutdown,
  registerRomWeaverShutdown,
  requestOpfsShutdown,
  waitForOpfsShutdownState,
} from "../browser-opfs-shutdown.ts";
import type { RomWeaverBrowserOpfsOptions, RomWeaverDefaultThreads } from "../rom-weaver-types.d.ts";
import { normalizeDefaultThreads, resolveBrowserDefaultThreads } from "./browser-thread-budget.ts";
import { createBrowserWorkerTransport, RomWeaverWorkerClientCore } from "./worker-client-core.ts";
// `?worker&url`, never `new URL(..., import.meta.url)` - see "Worker URLs" in docs/development/ARCHITECTURE.md.
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
  // Without cross-origin isolation SharedArrayBuffer is absent; keep construction from throwing so the runner can
  // report the COOP/COEP requirement itself. The buffer is only handed to a worker that threaded wasm would start.
  private readonly shutdownControl = new Int32Array(
    typeof SharedArrayBuffer === "function" ? new SharedArrayBuffer(8) : new ArrayBuffer(8),
  );
  private heardFromWorker = false;
  private failedBeforeAnyReply = false;
  private shutdownPromise: Promise<void> | null = null;
  private stopped = false;
  private initialized = false;
  private _defaultThreads: number | null;

  constructor(worker: Worker, options: Pick<BrowserWorkerClientOptions, "defaultThreads"> = {}) {
    options = options ?? {};
    super(worker, BROWSER_WORKER_TRANSPORT);
    this._defaultThreads = normalizeDefaultThreads(options.defaultThreads);
  }

  override _onMessage(rawMessage: Event) {
    this.heardFromWorker = true;
    super._onMessage(rawMessage);
  }

  override _onError(rawError: Event) {
    // An error before the worker ever replied means its script never ran (failed load, CSP), so it owns nothing.
    if (!this.heardFromWorker) this.failedBeforeAnyReply = true;
    super._onError(rawError);
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
    const requestId = this._nextRequestId;
    const pending = this._send<BrowserWorkerReadyResult>({
      mode: "browser-opfs",
      options: { ...options, __shutdownControl: this.shutdownControl.buffer as SharedArrayBuffer },
      type: "init",
    });
    // Worker replies MUST arrive asynchronously; a missing request here means postMessage failed synchronously.
    this.initialized ||= this._pending.has(requestId);
    return pending;
  }

  whenClosed(): Promise<void> {
    this.shutdownPromise ??= waitForOpfsShutdownState(this.shutdownControl, 2);
    return this.shutdownPromise;
  }

  terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    requestOpfsShutdown(this.shutdownControl);
    if (!this.initialized || this.failedBeforeAnyReply) acknowledgeOpfsShutdown(this.shutdownControl);
    if (Atomics.load(this.shutdownControl, 0) >= 2) {
      this._terminateWorker();
    } else {
      // Resource closure MUST precede native worker termination; failed closure still stops computation.
      void this.whenClosed().then(
        () => this._terminateWorker(),
        () => this._terminateWorker(),
      );
    }
    registerRomWeaverShutdown(this.whenClosed());
    this._shutdown("worker terminated");
  }
}
