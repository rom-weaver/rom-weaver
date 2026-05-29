import {
  createBrowserWorkerTransport,
  RomWeaverWorkerClientCore,
} from './worker-client-core.mjs';

const DEFAULT_BROWSER_THREAD_COUNT = 4;
const MAX_BROWSER_THREAD_COUNT = 64;

export function createBrowserWorkerClient(options = {}) {
  options = options ?? {};
  const createWorker = () => (
    options.worker ?? new Worker(
      options.workerUrl ?? new URL('./browser-runner-worker.mjs', import.meta.url),
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
  constructor(worker, options = {}) {
    options = options ?? {};
    super(worker, BROWSER_WORKER_TRANSPORT);
    this._defaultThreads = normalizeDefaultThreads(options.defaultThreads);
  }

  async init(options = {}) {
    options = options ?? {};
    const initOptions = this._createInitOptions(options);
    return this._sendInit(initOptions);
  }

  async run(commandOrRequest, options = {}) {
    return super.run(commandOrRequest, options);
  }

  async runJson(commandOrRequest, options = {}) {
    return super.runJson(commandOrRequest, options);
  }

  _createInitOptions(options) {
    const initOptions = { ...options };
    if (!Object.hasOwn(initOptions, 'defaultThreads') && this._defaultThreads !== null) {
      initOptions.defaultThreads = this._defaultThreads;
    }
    return initOptions;
  }

  _sendInit(options) {
    return this._send({
      type: 'init',
      mode: 'browser-opfs',
      options,
    });
  }

  terminate() {
    this._shutdown('worker terminated');
    this._terminateWorker();
  }
}

function resolveBrowserDefaultThreads(root = globalThis) {
  const hardwareConcurrency = Number(root?.navigator?.hardwareConcurrency);
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0) {
    return Math.max(1, Math.min(DEFAULT_BROWSER_THREAD_COUNT, Math.floor(hardwareConcurrency)));
  }
  return DEFAULT_BROWSER_THREAD_COUNT;
}

function normalizeDefaultThreads(value) {
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
