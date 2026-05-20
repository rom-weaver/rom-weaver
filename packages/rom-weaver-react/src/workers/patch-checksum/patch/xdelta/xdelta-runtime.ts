import { hasNodeWorkerRuntimePathReadSupport } from "../../../shared/node-worker-runtime.ts";

const XDELTA_BROWSER_MAIN_THREAD_ERROR = "xdelta3 wasm must run in a worker in browser environments";

type XdeltaRuntimeRoot = {
  document?: object;
  window?: object;
};

const isXdeltaBrowserMainThread = (runtimeRoot: XdeltaRuntimeRoot) =>
  typeof runtimeRoot.window === "object" &&
  runtimeRoot.window === runtimeRoot &&
  typeof runtimeRoot.document === "object" &&
  !hasNodeWorkerRuntimePathReadSupport();

const assertNotXdeltaBrowserMainThread = (runtimeRoot: XdeltaRuntimeRoot) => {
  if (isXdeltaBrowserMainThread(runtimeRoot)) throw new Error(XDELTA_BROWSER_MAIN_THREAD_ERROR);
};

export { assertNotXdeltaBrowserMainThread };
