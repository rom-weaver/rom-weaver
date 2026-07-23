// Bundler-agnostic asset resolution for the browser wasm runtime.
//
// The runtime needs four URLs: the wasm module plus the three worker
// entrypoints (runner, wasi-thread, opfs-proxy). Every one is resolved relative
// to this module via `new URL(..., import.meta.url)`, the one form Vite,
// webpack 5, and Rollup all rewrite to a copied asset URL. The resolved strings
// are then threaded through the worker client's init options as plain strings,
// so the actual `new Worker(url)` construction is never statically analyzed by a
// consumer's bundler.
//
// These paths point at the BUILT sibling files (`.js` workers, the `.wasm`
// binary) emitted next to this module in `dist/`, so consumers must load the
// built package, not the TypeScript sources.

export type RomWeaverWasmAssetUrls = {
  wasmUrl: string;
  runnerWorkerUrl: string;
  threadWorkerUrl: string;
  opfsProxyWorkerUrl: string;
};

/**
 * Resolve the wasm module and the three worker entrypoint URLs relative to this
 * package. Safe to call in any modern bundler or a native ES module context;
 * each URL is a `new URL(<literal>, import.meta.url)` the bundler can trace.
 */
export function getRomWeaverWasmAssetUrls(): RomWeaverWasmAssetUrls {
  return {
    wasmUrl: new URL("./rom-weaver-app.wasm", import.meta.url).href,
    runnerWorkerUrl: new URL("./workers/browser-runner-worker.js", import.meta.url).href,
    threadWorkerUrl: new URL("./workers/browser-wasi-thread-worker.js", import.meta.url).href,
    opfsProxyWorkerUrl: new URL("./workers/browser-opfs-proxy-worker.js", import.meta.url).href,
  };
}
