// Runner-side coordinator that spawns and owns the OPFS proxy worker.
//
// Builds the SharedArrayBuffer channel, spawns the dedicated proxy worker, hands it the mount handles,
// and exposes: a synchronous OpfsProxyClient for the runner thread, the serializable channel transfer
// to forward into spawned WASI threads (so they share the same proxy), and a stop() for teardown.
// Gated behind the I/O-mode flag in the runner - when off, none of this is constructed.

import { createOpfsProxyChannel, type OpfsProxyChannelTransfer } from "./browser-opfs-proxy-channel.ts";
import { OpfsProxyClient } from "./browser-opfs-proxy-client.ts";
import type { OpfsProxyMountBootstrap } from "./browser-opfs-proxy-server.ts";
import type { RomWeaverBrowserSyncAccessMode, TraceLine } from "./browser-opfs-runtime-types.ts";
// `?worker&url`, never `new URL(..., import.meta.url)` - see "Worker URLs" in docs/ARCHITECTURE.md.
import DEFAULT_OPFS_PROXY_WORKER_URL from "./workers/browser-opfs-proxy-worker.ts?worker&url";

const PROXY_READY_TIMEOUT_MS = 30_000;

export interface OpfsProxyRuntime {
  client: OpfsProxyClient;
  transfer: OpfsProxyChannelTransfer;
  stop(): Promise<void>;
  /** Point proxy-worker trace lines at a sink (the active run's trace) so they reach the app log. */
  setTrace(fn: ((line: string) => void) | null): void;
  /** Hand the proxy worker a read-only Blob input it serves by guest path (no OPFS staging copy).
   * Fire-and-forget: the runner registers before building fds, so it lands before any thread opens it. */
  registerBlobSource(path: string, blob: Blob): void;
  unregisterBlobSource(path: string): void;
}

export interface StartOpfsProxyRuntimeOptions {
  mounts: OpfsProxyMountBootstrap[];
  slotCount: number;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  trace?: TraceLine;
  /** Override the worker URL (tests / custom hosting); defaults to the bundled proxy worker. */
  workerUrl?: string | URL;
}

/** Spawn the proxy worker, wait for it to boot, and return a ready runtime. */
export async function startOpfsProxyRuntime(options: StartOpfsProxyRuntimeOptions): Promise<OpfsProxyRuntime> {
  // One-time per runner: spawning the proxy worker + waiting for its ready ack is part of cold
  // runner-creation latency (it precedes every op, so it is not counted in a run's setupMs).
  const spawnStartedAtMs = typeof performance === "undefined" ? 0 : performance.now();
  const channel = createOpfsProxyChannel(options.slotCount);
  const worker = new Worker(options.workerUrl ?? DEFAULT_OPFS_PROXY_WORKER_URL, {
    type: "module",
  });
  // Mutable so the runner can point proxy-worker traces at the *active run's* trace channel (the one
  // surfaced in the app log). startOpfsProxyRuntime is called once per runner, before any run, so there
  // is no run trace at construction; setTrace() updates it per run.
  let activeTrace = options.trace ?? null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("OPFS proxy worker did not become ready in time")),
      PROXY_READY_TIMEOUT_MS,
    );
    worker.onmessage = (event: MessageEvent<{ line?: string; message?: string; type?: string }>) => {
      const data = event.data;
      if (data?.type === "ready") {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (data?.type === "error") {
        clearTimeout(timer);
        reject(new Error(data.message ?? "OPFS proxy worker failed to bootstrap"));
        return;
      }
      if (data?.type === "trace" && data.line) activeTrace?.(data.line);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`OPFS proxy worker failed to start: ${event.message ?? "unknown error"}`));
    };
    worker.postMessage({
      channel: channel.transfer,
      mounts: options.mounts,
      syncAccessMode: options.syncAccessMode,
      type: "bootstrap",
    });
  });
  const spawnMs = (typeof performance === "undefined" ? 0 : performance.now()) - spawnStartedAtMs;
  activeTrace?.(
    `[browser-opfs] proxy runtime ready slots=${channel.slots.length} mounts=${options.mounts.length} spawnMs=${spawnMs.toFixed(1)}`,
  );

  const client = new OpfsProxyClient(channel, { trace: (line) => activeTrace?.(line) });
  return {
    client,
    registerBlobSource: (path, blob) => worker.postMessage({ blob, path, type: "register-blob-source" }),
    setTrace: (fn) => {
      activeTrace = fn;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        const settle = () => {
          worker.terminate();
          resolve();
        };
        const timer = setTimeout(settle, 5_000);
        worker.onmessage = (event: MessageEvent<{ type?: string }>) => {
          if (event.data?.type === "stopped") {
            clearTimeout(timer);
            settle();
          }
        };
        worker.postMessage({ type: "stop" });
      }),
    transfer: channel.transfer,
    unregisterBlobSource: (path) => worker.postMessage({ path, type: "unregister-blob-source" }),
  };
}
