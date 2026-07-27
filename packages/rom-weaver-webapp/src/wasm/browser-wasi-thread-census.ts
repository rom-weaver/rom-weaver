// Cross-realm census of dedicated Workers created to host WASI threads.
//
// Thread workers are created from more than one realm: the runner creates pool shells, and every
// spawned thread creates its own nested workers. A per-realm counter therefore cannot answer "how
// many workers did this run create?", so the counter lives in the OPFS proxy channel's shared global
// control region - the one SharedArrayBuffer every such realm already receives.

import {
  OPFS_PROXY_GLOBAL_THREAD_WORKERS_CREATED_INDEX,
  type OpfsProxyChannelTransfer,
} from "./browser-opfs-proxy-channel.ts";

let census: Int32Array<SharedArrayBuffer> | null = null;

/**
 * Points this realm's counter at the run's shared control region. Called by the runner right after
 * the proxy starts and by every thread worker before it can spawn nested threads. Attaching is
 * best-effort: a realm without a proxy channel simply stops counting rather than failing the run.
 */
export function attachThreadWorkerCensus(transfer: OpfsProxyChannelTransfer | null | undefined): void {
  const globalControl = transfer?.globalControl;
  if (!(globalControl instanceof SharedArrayBuffer)) {
    census = null;
    return;
  }
  const view = new Int32Array(globalControl);
  if (view.length <= OPFS_PROXY_GLOBAL_THREAD_WORKERS_CREATED_INDEX) {
    census = null;
    return;
  }
  census = view as Int32Array<SharedArrayBuffer>;
}

/** Records one `new Worker(threadWorkerUrl)`. Returns the new cross-realm total, or null if unattached. */
export function countThreadWorkerCreated(): number | null {
  if (!census) return null;
  return Atomics.add(census, OPFS_PROXY_GLOBAL_THREAD_WORKERS_CREATED_INDEX, 1) + 1;
}

/** Current cross-realm total, or null when this realm never attached. */
export function readThreadWorkerCensus(): number | null {
  if (!census) return null;
  return Atomics.load(census, OPFS_PROXY_GLOBAL_THREAD_WORKERS_CREATED_INDEX);
}
