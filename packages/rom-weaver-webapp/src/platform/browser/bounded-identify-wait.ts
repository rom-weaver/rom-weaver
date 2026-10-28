import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("identify-wait");

/** How long local work waits on the optional identification database before going on without it. */
const IDENTIFY_WAIT_BOUND_MS = 5000;

/**
 * Wait for optional identification work for at most `boundMs`. On timeout, resolve to
 * `onTimeout(reason)` and log a warning. The work itself is never cancelled: the service worker or
 * in-flight fetch keeps filling its cache for later lookups, and a late result or rejection is
 * dropped here so it cannot surface as an unhandled rejection or touch the caller's state.
 */
const boundIdentifyWait = <T, F>(
  work: Promise<T>,
  label: string,
  onTimeout: (reason: string) => F,
  boundMs = IDENTIFY_WAIT_BOUND_MS,
): Promise<T | F> =>
  new Promise<T | F>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      const reason = `${label} did not finish within ${boundMs} ms`;
      logger.warn("continuing without optional identification data", { reason });
      resolve(onTimeout(reason));
    }, boundMs);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });

export { boundIdentifyWait };
