import type { WorkerTransport, WorkerTransportPostMessageOptions } from "../../types/worker-messages.ts";

type ModuleWorkerOptions = {
  name?: string;
  type?: "module";
};

type BrowserWorkerFactory = () => Worker;

type WorkerTransportWithDebug = WorkerTransport & {
  __romWeaverWorkerDebug?: {
    workerName?: string;
    workerScriptUrl?: string;
  };
};

const normalizeTransferList = (transferList?: WorkerTransportPostMessageOptions): readonly unknown[] | undefined => {
  if (!transferList) return undefined;
  if (Array.isArray(transferList)) return transferList;
  if (Array.isArray(transferList.transfer)) return transferList.transfer;
  return undefined;
};

const getErrorMessage = (error: unknown) => (error instanceof Error && error.message ? error.message : String(error));

const createWorkerCreationError = (
  error: unknown,
  workerScriptUrl: string,
  workerName?: string,
): Error & {
  code?: string;
  details?: Record<string, unknown>;
} => {
  const message = getErrorMessage(error);
  const prefix = workerName ? `${workerName} worker failed to load` : "Worker failed to load";
  const wrapped = new Error(`${prefix}: ${message} (${workerScriptUrl})`) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  wrapped.code = "WORKER_UNAVAILABLE";
  wrapped.details = {
    phase: "worker.constructor",
    workerName,
    workerScriptUrl,
  };
  return wrapped;
};

const createWorkerTransport = (rawWorker: Worker): WorkerTransport => ({
  get onerror() {
    return rawWorker.onerror;
  },
  set onerror(handler) {
    rawWorker.onerror = handler;
  },
  get onmessage() {
    return rawWorker.onmessage as WorkerTransport["onmessage"];
  },
  set onmessage(handler) {
    rawWorker.onmessage = handler as Worker["onmessage"];
  },
  get onmessageerror() {
    return rawWorker.onmessageerror;
  },
  set onmessageerror(handler) {
    rawWorker.onmessageerror = handler;
  },
  postMessage(message, transferList) {
    rawWorker.postMessage(message, normalizeTransferList(transferList) as Transferable[]);
  },
  terminate() {
    rawWorker.terminate();
  },
});

const attachWorkerTransportDebug = (
  transport: WorkerTransport,
  workerScriptUrl: string,
  workerName?: string,
): WorkerTransport => {
  const debugTransport = transport as WorkerTransportWithDebug;
  debugTransport.__romWeaverWorkerDebug = {
    workerName,
    workerScriptUrl,
  };
  return debugTransport;
};

const createModuleWorker = (url: string | URL, options: ModuleWorkerOptions = { type: "module" }): WorkerTransport => {
  if (typeof Worker !== "function") throw new Error("Worker constructor is not available");
  const normalizedUrl = url instanceof URL ? url : new URL(String(url), import.meta.url);
  const rawWorker = new Worker(normalizedUrl, {
    type: "module",
    ...options,
  });

  return attachWorkerTransportDebug(
    createWorkerTransport(rawWorker),
    normalizedUrl.href,
    typeof options.name === "string" ? options.name : undefined,
  );
};

const createRelativeModuleWorker = (
  relativePath: string,
  importMetaUrl: string,
  options: ModuleWorkerOptions = { type: "module" },
) => createModuleWorker(new URL(relativePath, importMetaUrl), options);

const createModuleWorkerFromBrowserFactory = (
  createBrowserWorker: BrowserWorkerFactory,
  url: string | URL,
  options: ModuleWorkerOptions = { type: "module" },
) => {
  const normalizedUrl = url instanceof URL ? url : new URL(String(url), import.meta.url);
  const workerName = typeof options.name === "string" ? options.name : undefined;
  try {
    return attachWorkerTransportDebug(createWorkerTransport(createBrowserWorker()), normalizedUrl.href, workerName);
  } catch (error) {
    throw createWorkerCreationError(error, normalizedUrl.href, workerName);
  }
};

const createRelativeModuleWorkerFromBrowserFactory = (
  createBrowserWorker: BrowserWorkerFactory,
  relativePath: string,
  importMetaUrl: string,
  options: ModuleWorkerOptions = { type: "module" },
) => createModuleWorkerFromBrowserFactory(createBrowserWorker, new URL(relativePath, importMetaUrl), options);

export type { ModuleWorkerOptions };
export {
  createModuleWorker,
  createModuleWorkerFromBrowserFactory,
  createRelativeModuleWorker,
  createRelativeModuleWorkerFromBrowserFactory,
};
