import { emitTraceLog } from "../../lib/logging.ts";
import type { LogRecord } from "../../types/logging.ts";

type BrowserVirtualFileSource = Blob | Uint8Array | ArrayBuffer;

// Per-call trace gating: callers thread the active run's log level and onLog sink through so virtual
// file registration emits through the shared logger (gated by the actual log level setting) instead of
// spamming the console unconditionally. Shape mirrors the source-ref trace context it is forwarded from.
type BrowserVirtualFileTraceContext = {
  logLevel?: string;
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
};

// Every browser input is served read-only through the OPFS proxy worker by guest path: the runner hands
// `source` to the proxy via registerBlobSource and the mount builds a BrowserProxyRandomAccessFile for
// it. `useProxyHandle` is always set; it stays on the record so the mount can pick the proxy inode.
type BrowserVirtualFile = {
  path: string;
  source?: BrowserVirtualFileSource;
  useProxyHandle?: boolean;
};

const activeVirtualFiles = new Map<string, BrowserVirtualFile>();

const getVirtualSourceSize = (source: BrowserVirtualFileSource) =>
  source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size;

const getVirtualSourceKind = (source: BrowserVirtualFileSource) => {
  if (typeof File !== "undefined" && source instanceof File) return "file";
  if (typeof Blob !== "undefined" && source instanceof Blob) return "blob";
  if (source instanceof Uint8Array) return "uint8array";
  if (source instanceof ArrayBuffer) return "arraybuffer";
  return typeof source;
};

const emitVirtualFileTrace = (
  trace: BrowserVirtualFileTraceContext | undefined,
  message: string,
  details?: Record<string, unknown>,
) =>
  emitTraceLog(
    { logLevel: trace?.logLevel, namespace: "runtime:browser-virtual-files", onLog: trace?.onLog },
    message,
    details || {},
  );

const registerBrowserVirtualFile = ({
  path,
  source,
  trace,
}: {
  path: string;
  source: BrowserVirtualFileSource;
  trace?: BrowserVirtualFileTraceContext;
}): (() => void) => {
  const sourceSize = getVirtualSourceSize(source);
  const sourceKind = getVirtualSourceKind(source);
  // The runner forwards this source to the OPFS proxy worker (served by guest path); we just carry it +
  // the flag so getActiveBrowserVirtualFiles hands it to the run and the mount builds a proxy inode.
  const file: BrowserVirtualFile = { path, source, useProxyHandle: true };
  activeVirtualFiles.set(path, file);
  emitVirtualFileTrace(trace, "registered proxy-handle virtual file", { path, sourceKind, sourceSize });
  return () => {
    emitVirtualFileTrace(trace, "unregistered proxy-handle virtual file", { path, sourceKind, sourceSize });
    if (activeVirtualFiles.get(path) === file) activeVirtualFiles.delete(path);
  };
};

const getActiveBrowserVirtualFiles = (): BrowserVirtualFile[] =>
  Array.from(activeVirtualFiles.values()).map((file) => ({ ...file }));

export type { BrowserVirtualFile };
export { getActiveBrowserVirtualFiles, registerBrowserVirtualFile };
