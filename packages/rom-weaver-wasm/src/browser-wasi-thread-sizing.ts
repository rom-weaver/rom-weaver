import type { RomWeaverRunInput, RomWeaverRunRequest } from "./browser-opfs-runtime-types.ts";
import { readRomWeaverRequestedThreadCount } from "./rom-weaver-command.ts";
import { resolveBrowserDefaultThreads } from "./workers/browser-thread-budget.ts";

export const DEFAULT_BROWSER_THREAD_COUNT = 4;
export const MAX_BROWSER_THREAD_POOL_SIZE = 64;
const BROWSER_THREAD_POOL_HEADROOM = 4;

export function resolveBrowserThreadPoolSizeFromRequest(request: RomWeaverRunRequest | undefined): number {
  if (request === undefined) {
    throw new TypeError("browser wasi thread pool sizing requires a runtime request");
  }
  return resolveBrowserThreadPoolSizeFromCount(parseRequestedThreadCount(request));
}

export function resolveBrowserThreadPoolSizeFromCount(requestedThreadCount: number | null): number {
  if (requestedThreadCount === null || requestedThreadCount <= 1) return 0;
  const requested = Math.min(Math.max(1, requestedThreadCount), MAX_BROWSER_THREAD_POOL_SIZE);
  // Rayon workers stay parked while container decoders may spawn a second,
  // transient thread wave. Reserve both up front because synchronous spawn
  // cannot grow the pool and would deadlock waiting for a parked worker.
  const headroom = Math.max(BROWSER_THREAD_POOL_HEADROOM, requested);
  return Math.min(requested + headroom, MAX_BROWSER_THREAD_POOL_SIZE);
}

export function parseRequestedThreadCount(request: RomWeaverRunInput): number | null {
  return readRomWeaverRequestedThreadCount(request, browserThreadRequestOptions());
}

// `autoThreads` and the implicit `defaultThreads` resolve "auto" (and the unset default) to the host
// core count via resolveBrowserDefaultThreads, so the engine honours the UI's advertised
// "auto = browser-reported core count" contract instead of collapsing every host to a flat 4 threads.
export function browserThreadRequestOptions(defaultThreads: number = resolveBrowserDefaultThreads()) {
  return {
    autoThreads: resolveBrowserDefaultThreads(),
    defaultThreads,
    maxThreads: MAX_BROWSER_THREAD_POOL_SIZE,
  };
}
