const isBrowserWindowRuntime = () =>
  typeof window === "object" && window.window === window && typeof window.document === "object";

const isBrowserWorkerRuntime = () => {
  if (!(typeof self === "object" && self)) return false;
  const protocol =
    typeof location === "object" && typeof location.protocol === "string" ? location.protocol.toLowerCase() : "";
  const hasBrowserWorkerLocation =
    protocol === "http:" ||
    protocol === "https:" ||
    protocol === "blob:" ||
    protocol === "data:" ||
    protocol === "file:";
  if (!hasBrowserWorkerLocation) return false;
  return self === globalThis || (typeof WorkerGlobalScope === "function" && self instanceof WorkerGlobalScope);
};

const isBrowserRuntime = () => isBrowserWindowRuntime() || isBrowserWorkerRuntime();

const isNodeRuntime = () => false;

export { isBrowserRuntime, isNodeRuntime };
