import type { RomWeaverDefaultThreads } from "../rom-weaver-types.d.ts";
import {
  clampBrowserThreadCount,
  DEFAULT_BROWSER_THREAD_COUNT,
  MAX_BROWSER_THREAD_COUNT,
} from "../../platform/shared/browser-thread-defaults.ts";

/**
 * Resolve the implicit default thread count from the host environment: `navigator.hardwareConcurrency`
 * clamped to `[DEFAULT_BROWSER_THREAD_COUNT, MAX_BROWSER_THREAD_COUNT]`. Mirrors the UI-facing
 * `getDefaultThreadCount` so the engine honours the advertised "auto = core count" contract. Falls
 * back to `DEFAULT_BROWSER_THREAD_COUNT` when `navigator.hardwareConcurrency` is unavailable or invalid.
 */
export function resolveBrowserDefaultThreads(root: typeof globalThis = globalThis): number {
  const hardwareConcurrency = Number(root?.navigator?.hardwareConcurrency);
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0) {
    return clampBrowserThreadCount(hardwareConcurrency);
  }
  return DEFAULT_BROWSER_THREAD_COUNT;
}

/**
 * Normalize a configured `defaultThreads` option into a thread count, or `null` when threading is
 * disabled (`undefined`/`null`/`false`/`0`/`'0'`/`'off'`). Throws on any other non-positive-integer
 * input. Positive values are clamped to `[1, MAX_BROWSER_THREAD_COUNT]`.
 */
export function normalizeDefaultThreads(value: RomWeaverDefaultThreads): number | null {
  if (value === undefined || value === null || value === false || value === 0 || value === "0" || value === "off") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`defaultThreads must be a positive integer; received: ${value}`);
  }
  return Math.max(1, Math.min(MAX_BROWSER_THREAD_COUNT, parsed));
}
