import type { TraceLine } from "./browser-opfs-runtime-types.ts";

/**
 * One-shot forensics for a thread worker that refuses to load.
 *
 * WebKit reports a worker script that failed to load as a bare `Event` with an empty
 * `message`/`filename`/`lineno`, so the failure itself carries no cause (see the iOS 0.8.0 reports
 * where all eight pool shells died <1ms after `new Worker` with nothing but the URL). These probes
 * run once per runtime, on the first failure only, and answer the two questions the blank event
 * cannot: did the host serve the script we think it did, and can this context start *any* nested
 * module worker?
 *
 * Every probe is best-effort and swallows its own errors: this is diagnostics hanging off a path
 * that is already failing, and it must never change what the caller reports.
 */

const PROBE_TIMEOUT_MS = 3000;
const RESPONSE_PREFIX_LENGTH = 48;
// Smallest possible module worker: no imports, no shared memory, just proof that the context can
// stand one up. Inline so the probe never depends on another asset resolving.
const CONTROL_WORKER_SOURCE = 'self.postMessage("control-worker-online");';

let probed = false;

/** Reset between tests; production runs probe exactly once per runtime. */
export function __resetThreadWorkerLoadProbe(): void {
  probed = false;
}

const withTimeout = <T>(work: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS);
    }),
  ]);

/**
 * Describe the failure event itself. A plain `Event` means the script never ran (fetch, MIME, or
 * policy); a populated `ErrorEvent` means it ran and threw. That split is the single most useful
 * bit here and it is otherwise discarded.
 */
export function describeThreadWorkerErrorEvent(event: Event): string {
  const isErrorEvent = typeof ErrorEvent === "function" && event instanceof ErrorEvent;
  const constructorName = event?.constructor?.name ?? "unknown";
  const hasError = isErrorEvent && Boolean((event as ErrorEvent).error);
  return `eventType=${event?.type ?? "unknown"}; eventClass=${constructorName}; isErrorEvent=${isErrorEvent}; hasErrorObject=${hasError}`;
}

/** What the host actually served for the worker URL, through whatever service worker is in play. */
const probeWorkerResponse = async (workerUrl: string, trace: TraceLine): Promise<void> => {
  try {
    const response = await withTimeout(fetch(workerUrl), null);
    if (!response) {
      trace(`[browser-opfs] thread worker probe fetch timed out after ${PROBE_TIMEOUT_MS}ms url=${workerUrl}`);
      return;
    }
    const body = await withTimeout(response.text(), "");
    trace(
      `[browser-opfs] thread worker probe fetch status=${response.status} ok=${response.ok}` +
        ` responseType=${response.type} redirected=${response.redirected}` +
        ` contentType=${response.headers.get("content-type") ?? "none"}` +
        ` coep=${response.headers.get("cross-origin-embedder-policy") ?? "none"}` +
        ` corp=${response.headers.get("cross-origin-resource-policy") ?? "none"}` +
        ` bytes=${body.length} prefix=${JSON.stringify(body.slice(0, RESPONSE_PREFIX_LENGTH))}`,
    );
  } catch (error) {
    trace(`[browser-opfs] thread worker probe fetch threw url=${workerUrl} ${String(error)}`);
  }
};

/** Can this context start a nested module worker at all, independent of our bundle? */
const probeControlWorker = async (trace: TraceLine): Promise<void> => {
  let objectUrl = "";
  let worker: Worker | null = null;
  try {
    objectUrl = URL.createObjectURL(new Blob([CONTROL_WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(objectUrl, { type: "module" });
    const controlWorker = worker;
    const outcome = await withTimeout(
      new Promise<string>((resolve) => {
        controlWorker.addEventListener("message", () => resolve("online"));
        controlWorker.addEventListener("error", (event) =>
          resolve(`failed (${describeThreadWorkerErrorEvent(event)})`),
        );
      }),
      "timed out",
    );
    trace(`[browser-opfs] thread worker probe control module worker ${outcome}`);
  } catch (error) {
    trace(`[browser-opfs] thread worker probe control module worker threw ${String(error)}`);
  } finally {
    try {
      worker?.terminate();
    } catch {
      // ignored
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
};

/**
 * Run the probes once per runtime. Fire-and-forget: the caller is already reporting its failure and
 * must not wait on (or be affected by) this.
 */
export function probeThreadWorkerLoadFailure(workerUrl: string, trace?: TraceLine): void {
  if (probed || !trace) return;
  probed = true;
  trace(`[browser-opfs] thread worker probe start url=${workerUrl}`);
  void (async () => {
    await probeWorkerResponse(workerUrl, trace);
    await probeControlWorker(trace);
    trace("[browser-opfs] thread worker probe done");
  })();
}
