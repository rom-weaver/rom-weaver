import type { RomWeaverDefaultThreads } from '../rom-weaver-types.d.ts';

// Default worker thread count when none is configured. Browsers cap concurrency aggressively, so we
// stay conservative and only scale up to this from `navigator.hardwareConcurrency`.
export const DEFAULT_BROWSER_THREAD_COUNT = 4;

// Upper bound for an explicitly configured browser thread count. Keeps a runaway `defaultThreads`
// option from oversubscribing the pool.
export const MAX_BROWSER_THREAD_COUNT = 64;

/**
 * Resolve the implicit default thread count from the host environment, clamped to
 * `[1, DEFAULT_BROWSER_THREAD_COUNT]`. Falls back to `DEFAULT_BROWSER_THREAD_COUNT` when
 * `navigator.hardwareConcurrency` is unavailable or invalid.
 */
export function resolveBrowserDefaultThreads(root: typeof globalThis = globalThis): number {
  const hardwareConcurrency = Number(root?.navigator?.hardwareConcurrency);
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0) {
    return Math.max(1, Math.min(DEFAULT_BROWSER_THREAD_COUNT, Math.floor(hardwareConcurrency)));
  }
  return DEFAULT_BROWSER_THREAD_COUNT;
}

/**
 * Normalize a configured `defaultThreads` option into a thread count, or `null` when threading is
 * disabled (`undefined`/`null`/`false`/`0`/`'0'`/`'off'`). Throws on any other non-positive-integer
 * input. Positive values are clamped to `[1, MAX_BROWSER_THREAD_COUNT]`.
 */
export function normalizeDefaultThreads(value: RomWeaverDefaultThreads): number | null {
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
