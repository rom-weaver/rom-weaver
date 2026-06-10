import { readRomWeaverRequestedThreadCount } from './rom-weaver-command.ts';
import type {
  RomWeaverRunInput,
  RomWeaverRunRequest,
} from './browser-opfs-runtime-types.ts';

export const DEFAULT_BROWSER_THREAD_COUNT = 4;
export const MAX_BROWSER_THREAD_POOL_SIZE = 64;
const BROWSER_THREAD_POOL_HEADROOM = 4;

export function resolveBrowserThreadPoolSizeFromRequest(request: RomWeaverRunRequest | undefined): number {
  if (request === undefined) {
    throw new TypeError('browser wasi thread pool sizing requires a runtime request');
  }
  return resolveBrowserThreadPoolSizeFromCount(parseRequestedThreadCount(request));
}

export function resolveBrowserThreadPoolSizeFromCount(requestedThreadCount: number | null): number {
  if (requestedThreadCount === null || requestedThreadCount <= 1) return 0;
  const requested = Math.min(Math.max(1, requestedThreadCount), MAX_BROWSER_THREAD_POOL_SIZE);
  return Math.min(requested + BROWSER_THREAD_POOL_HEADROOM, MAX_BROWSER_THREAD_POOL_SIZE);
}

export function parseRequestedThreadCount(request: RomWeaverRunInput): number | null {
  return readRomWeaverRequestedThreadCount(
    request,
    browserThreadRequestOptions(DEFAULT_BROWSER_THREAD_COUNT),
  );
}

export function browserThreadRequestOptions(defaultThreads: number = DEFAULT_BROWSER_THREAD_COUNT) {
  return {
    autoThreads: DEFAULT_BROWSER_THREAD_COUNT,
    defaultThreads,
    maxThreads: MAX_BROWSER_THREAD_POOL_SIZE,
  };
}
