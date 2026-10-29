import { getManagedOpfsFileHandle } from "../../workers/protocol/opfs-path.ts";
import { acknowledgeOpfsShutdown } from "../browser-opfs-shutdown.ts";
// This dedicated worker owns the runner's OPFS handles and resolves mount paths from the OPFS root.
// File I/O uses the shared channel; bootstrap, Blob registration, tracing, and shutdown use postMessage.

import { attachOpfsProxyChannel, type OpfsProxyChannelTransfer } from "../browser-opfs-proxy-channel.ts";
import {
  type OpfsProxyMountBootstrap,
  type OpfsProxyServerHandle,
  startOpfsProxyServer,
} from "../browser-opfs-proxy-server.ts";
import type { FileSystemDirectoryHandleLike, RomWeaverBrowserSyncAccessMode } from "../browser-opfs-runtime-types.ts";

interface ProxyBootstrapMessage {
  channel: OpfsProxyChannelTransfer;
  shutdownControl: SharedArrayBuffer;
  mounts: OpfsProxyMountBootstrap[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  type: "bootstrap";
}

interface ProxyStopMessage {
  type: "stop";
}

// Control-plane messages (not data-plane I/O, which goes over the shared channel): register/unregister
// a read-only Blob input the server serves by guest path without staging it into OPFS.
interface ProxyRegisterBlobMessage {
  type: "register-blob-source";
  path: string;
  blob: Blob;
}

interface ProxyUnregisterBlobMessage {
  type: "unregister-blob-source";
  path: string;
}

interface ProxyReadPrefixMessage {
  type: "read-prefix";
  filePath: string;
  length: number;
  requestId: string;
}

const readPrefix = async (data: ProxyReadPrefixMessage): Promise<void> => {
  try {
    if (!Number.isInteger(data.length) || data.length < 0 || data.length > 32 * 2048)
      throw new Error("OPFS prefix length must be an integer between 0 and 65536");
    if (typeof data.filePath !== "string" || !data.filePath.trim()) throw new Error("OPFS prefix path is required");
    const handle = await getManagedOpfsFileHandle(data.filePath, { create: false });
    if (!handle) throw new Error(`OPFS prefix file not found: ${data.filePath}`);
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.slice(0, data.length).arrayBuffer());
    workerScope.postMessage({ type: "read-prefix-complete", requestId: data.requestId, bytes }, [bytes.buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: "read-prefix-error",
      requestId: data.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

type ProxyWorkerMessage =
  | ProxyReadPrefixMessage
  | ProxyBootstrapMessage
  | ProxyStopMessage
  | ProxyRegisterBlobMessage
  | ProxyUnregisterBlobMessage;

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
      shutdownControl: new Int32Array(data.shutdownControl),
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
    if (server) {
      server.stop();
      await server.done;
    } else {
      acknowledgeOpfsShutdown(new Int32Array(data.shutdownControl));
    }
    workerScope.postMessage({ message: `OPFS proxy bootstrap failed: ${String(error)}`, type: "error" });
  }
};

workerScope.onmessage = (event: MessageEvent<ProxyWorkerMessage>) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "read-prefix") {
    void readPrefix(data);
    return;
  }
  if (data.type === "bootstrap") {
    void bootstrap(data);
    return;
  }
  if (data.type === "register-blob-source") {
    // Registered before the run opens the path; the server resolves it to a Blob-backed read handle.
    server?.registerBlobSource(data.path, data.blob);
    return;
  }
  if (data.type === "unregister-blob-source") {
    server?.unregisterBlobSource(data.path);
    return;
  }
  if (data.type === "stop") {
    if (!server) {
      workerScope.postMessage({ type: "stopped" });
      return;
    }
    server.stop();
    void server.done.then(() => workerScope.postMessage({ type: "stopped" }));
  }
};
