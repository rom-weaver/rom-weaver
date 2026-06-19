// Runner-side coordinator that spawns and owns the OPFS proxy worker.
//
// Builds the SharedArrayBuffer channel, spawns the dedicated proxy worker, hands it the mount handles,
// and exposes: a synchronous OpfsProxyClient for the runner thread, the serializable channel transfer
// to forward into spawned WASI threads (so they share the same proxy), and a stop() for teardown.
// Gated behind the I/O-mode flag in the runner — when off, none of this is constructed.

import { createOpfsProxyChannel, type OpfsProxyChannelTransfer } from "./browser-opfs-proxy-channel.ts";
import { OpfsProxyClient } from "./browser-opfs-proxy-client.ts";
import type { OpfsProxyMountBootstrap } from "./browser-opfs-proxy-server.ts";
import type { RomWeaverBrowserSyncAccessMode, TraceLine } from "./browser-opfs-runtime-types.ts";

const PROXY_READY_TIMEOUT_MS = 30_000;

export interface OpfsProxyRuntime {
  client: OpfsProxyClient;
  transfer: OpfsProxyChannelTransfer;
  stop(): Promise<void>;
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
  // The `new URL(..., import.meta.url)` MUST stay inline inside the Worker constructor: that is the
  // pattern Vite statically detects to bundle the worker for production. Hoisting it into a variable
  // first makes Vite ship the raw .ts asset instead, so the worker 404s/parse-fails in a prod build
  // (dev hides this by transforming .ts on the fly). Mirrors workers/browser-worker-client.ts.
  const worker = new Worker(options.workerUrl ?? new URL("./workers/browser-opfs-proxy-worker.ts", import.meta.url), {
    type: "module",
  });
  const trace = options.trace;

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
      if (data?.type === "trace" && data.line) trace?.(data.line);
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
  trace?.(
    `[browser-opfs] proxy runtime ready slots=${channel.slots.length} mounts=${options.mounts.length} spawnMs=${spawnMs.toFixed(1)}`,
  );

  const client = new OpfsProxyClient(channel, { trace });
  return {
    client,
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
  };
}
