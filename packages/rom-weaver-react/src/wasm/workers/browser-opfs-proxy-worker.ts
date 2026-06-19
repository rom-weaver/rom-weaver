// Dedicated worker entry for the OPFS async proxy.
//
// This worker is the single owner of every OPFS handle for a runner. It boots from a `bootstrap`
// message carrying the SharedArrayBuffer channel and the mount directory handles, then runs the async
// servicing loop in browser-opfs-proxy-server.ts until told to stop. It is spawned by the runner
// (browser-opfs-proxy-runtime.ts); consumers on the main runner thread and spawned WASI threads talk
// to it only through the shared channel, never via postMessage.

import { attachOpfsProxyChannel, type OpfsProxyChannelTransfer } from "../browser-opfs-proxy-channel.ts";
import {
  type OpfsProxyMountBootstrap,
  type OpfsProxyServerHandle,
  startOpfsProxyServer,
} from "../browser-opfs-proxy-server.ts";
import type { FileSystemDirectoryHandleLike, RomWeaverBrowserSyncAccessMode } from "../browser-opfs-runtime-types.ts";

interface ProxyBootstrapMessage {
  channel: OpfsProxyChannelTransfer;
  mounts: OpfsProxyMountBootstrap[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  type: "bootstrap";
}

interface ProxyStopMessage {
  type: "stop";
}

type ProxyWorkerMessage = ProxyBootstrapMessage | ProxyStopMessage;

const workerScope = self as unknown as Worker;
let server: OpfsProxyServerHandle | null = null;

const bootstrap = async (data: ProxyBootstrapMessage): Promise<void> => {
  try {
    const channel = attachOpfsProxyChannel(data.channel);
    // Resolve each mount's directory handle here rather than receiving it in the message: Safari/iOS
    // cannot structured-clone a FileSystemDirectoryHandle to a nested worker. Navigate from the
    // per-origin OPFS root through the path the runner computed via `root.resolve(handle)`.
    const root = await navigator.storage.getDirectory();
    const mounts = [];
    for (const mount of data.mounts) {
      let directoryHandle = root as unknown as FileSystemDirectoryHandleLike;
      for (const part of mount.rootRelativeParts) {
        directoryHandle = (await directoryHandle.getDirectoryHandle(part, {
          create: false,
        })) as FileSystemDirectoryHandleLike;
      }
      mounts.push({ directoryHandle, mountPath: mount.mountPath, writableRoots: mount.writableRoots });
    }
    server = startOpfsProxyServer({
      channel,
      mounts,
      syncAccessMode: data.syncAccessMode,
      trace: (line) => {
        // Surface to the worker console (captured by the test runner) and forward to the runtime.
        if (line.includes("failed")) console.error(line);
        workerScope.postMessage({ line, type: "trace" });
      },
    });
    workerScope.postMessage({ type: "ready" });
  } catch (error) {
    workerScope.postMessage({ message: `OPFS proxy bootstrap failed: ${String(error)}`, type: "error" });
  }
};

workerScope.onmessage = (event: MessageEvent<ProxyWorkerMessage>) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "bootstrap") {
    void bootstrap(data);
    return;
  }
  if (data.type === "stop") {
    if (!server) {
      workerScope.postMessage({ type: "stopped" });
      return;
    }
    server.stop();
    server.done.then(() => workerScope.postMessage({ type: "stopped" }));
  }
};
