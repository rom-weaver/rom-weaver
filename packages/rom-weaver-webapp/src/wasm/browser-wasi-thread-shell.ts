import type { ThreadStartControl } from "./browser-wasi-thread-protocol.ts";
import { THREAD_SLOT_LENGTH, THREAD_SLOT_STATE_INDEX } from "./browser-wasi-thread-protocol.ts";
// `?worker&url`, never `new URL(..., import.meta.url)` - see "Worker URLs" in docs/ARCHITECTURE.md.
import BUILT_THREAD_WORKER_URL from "./workers/browser-wasi-thread-worker.ts?worker&url";

export const THREAD_WORKER_READY_TIMEOUT_MS = 5000;
export const THREAD_WORKER_BUSY_RETRY_INTERVAL_MS = 25;
export const THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS = 30000;
/** One synchronous spawn attempt yields briefly, then returns EAGAIN so the guest can retry. */
export const THREAD_WORKER_SATURATION_WAIT_MS = 250;

export function createThreadSlotControl(): ThreadStartControl {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH)) as ThreadStartControl;
}

export function loadThreadSlotState(control: ThreadStartControl): number {
  return Atomics.load(control, THREAD_SLOT_STATE_INDEX);
}

// The thread worker runs with full access to the shared wasm memory, so its URL must stay
// on our own origin. Callers pass a build-resolved URL; anything that resolves elsewhere
// (a `data:`/`https://evil` string threaded in from untrusted config) is rejected outright
// rather than spawned (CodeQL js/client-side-unvalidated-url-redirection).
const assertSameOriginWorkerUrl = (href: string): string => {
  const origin = typeof self === "undefined" ? undefined : self.location?.origin;
  if (!origin) return href;
  let resolved: URL;
  try {
    resolved = new URL(href, origin);
  } catch {
    throw new Error(`thread worker URL is not a valid URL: ${href}`);
  }
  if (resolved.origin !== origin)
    throw new Error(`thread worker URL must be same-origin (${origin}), got ${resolved.origin}`);
  return resolved.href;
};

export function resolveThreadWorkerUrl(value: string | URL | undefined): string {
  if (value instanceof URL) return assertSameOriginWorkerUrl(value.href);
  if (typeof value === "string" && value.trim().length > 0) return assertSameOriginWorkerUrl(value);
  return BUILT_THREAD_WORKER_URL;
}
