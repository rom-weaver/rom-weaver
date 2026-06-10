import type { FileSystemDirectoryHandleLike } from "./browser-opfs-runtime-types.ts";
import { openSyncAccessHandle, type SyncAccessHandleLike } from "./browser-opfs-sync-access.ts";
import { normalizeGuestPath } from "./rom-weaver-runtime-utils.ts";

declare const FileSystemSyncAccessHandle: unknown;

const DEFAULT_BROWSER_WASM_URLS = [new URL("./rom-weaver-app.wasm", import.meta.url).href];

type ResolvedBrowserModule = {
  module: WebAssembly.Module;
  wasmByteLength: number | null;
  wasmSha: string;
  wasmUrl: string | null;
};

type WasmModuleIdentity = {
  wasmByteLength: number | null;
  wasmSha: string;
};

export async function verifyWritableOpfsRoot(rootHandle: FileSystemDirectoryHandleLike): Promise<void> {
  const probeName = `.rw-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeFile = await rootHandle.getFileHandle(probeName, { create: true });
  let accessHandle: SyncAccessHandleLike | null = null;
  try {
    accessHandle = await openSyncAccessHandle({ fileHandle: probeFile, mode: "readwrite" });
    accessHandle.write(new Uint8Array([0x52, 0x57]), { at: 0 });
    accessHandle.flush();
  } catch (error) {
    throw new Error(`OPFS root is not writable with sync access handles: ${error}`);
  } finally {
    if (accessHandle) {
      try {
        accessHandle.close();
      } catch {
        // ignore best-effort close failures
      }
    }
    try {
      await rootHandle.removeEntry?.(probeName);
    } catch {
      // ignore best-effort cleanup failures
    }
  }
}

export function assertDedicatedWorkerRuntime() {
  if (typeof navigator === "undefined" || typeof self === "undefined") {
    throw new Error("createRomWeaverBrowserOpfs can only run in a browser runtime");
  }

  if (typeof window !== "undefined") {
    throw new Error(
      "createRomWeaverBrowserOpfs must run in a Dedicated Worker. " +
        "FileSystemSyncAccessHandle is not available on the main thread.",
    );
  }

  if (typeof FileSystemSyncAccessHandle === "undefined") {
    throw new Error(
      "FileSystemSyncAccessHandle is not available in this runtime. " +
        "Run inside a secure-context Dedicated Worker with OPFS support.",
    );
  }
}

export function assertDirectoryHandle(handle: unknown, label: string): asserts handle is FileSystemDirectoryHandleLike {
  if (!isDirectoryHandle(handle)) {
    throw new TypeError(`${label} must be a FileSystemDirectoryHandle`);
  }
}

function isDirectoryHandle(handle: unknown): handle is FileSystemDirectoryHandleLike {
  if (!handle || typeof handle !== "object") return false;
  const candidate = handle as Partial<FileSystemDirectoryHandleLike>;
  return Boolean(
    candidate.kind === "directory" &&
      typeof candidate.entries === "function" &&
      typeof candidate.getDirectoryHandle === "function" &&
      typeof candidate.getFileHandle === "function",
  );
}

export async function resolveBrowserModule({
  module,
  wasmUrl,
}: {
  module?: WebAssembly.Module;
  wasmUrl?: string | URL;
} = {}): Promise<ResolvedBrowserModule> {
  if (module instanceof WebAssembly.Module) {
    return {
      module,
      wasmByteLength: null,
      wasmSha: "",
      wasmUrl: normalizeConfiguredWasmUrls(wasmUrl, [null])[0] ?? null,
    };
  }

  const resolvedWasmUrls = normalizeConfiguredWasmUrls(wasmUrl, DEFAULT_BROWSER_WASM_URLS);
  return compileBrowserModuleFromUrls(resolvedWasmUrls);
}

export function canUseThreadedWasmRuntime(): boolean {
  return typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
}

function normalizeConfiguredWasmUrls(
  url: string | URL | undefined,
  fallbacks: ReadonlyArray<string | null>,
): ReadonlyArray<string | null> {
  if (url instanceof URL) return [url.href];
  if (typeof url === "string" && url.trim().length > 0) return [url];
  return fallbacks;
}

async function compileBrowserModuleFromUrls(urls: ReadonlyArray<string | null>): Promise<ResolvedBrowserModule> {
  let lastError: unknown = null;
  for (const url of urls) {
    if (!url) continue;
    try {
      return await compileBrowserModuleFromUrl(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no wasm module URL was configured");
}

// Reads a wasm response clone and returns its byte length plus a short SHA-256 prefix. Surfaced in the
// run-start trace so a stale or browser-cached binary is immediately distinguishable from a fresh build
// (e.g. after a rebuild during dev) without inspecting the network tab. Best-effort: every failure yields
// an empty identity rather than blocking module load.
async function describeWasmModuleIdentity(response: Response): Promise<WasmModuleIdentity> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let sha = "";
    if (globalThis.crypto?.subtle) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      sha = Array.from(digest.subarray(0, 4))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }
    return { wasmByteLength: bytes.byteLength, wasmSha: sha };
  } catch (_identityError) {
    return { wasmByteLength: null, wasmSha: "" };
  }
}

async function compileBrowserModuleFromUrl(url: string): Promise<ResolvedBrowserModule> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch wasm module from ${url}: ${response.status} ${response.statusText}`);
  }
  // Capture identity from a clone so the streaming compile path below is unaffected.
  const identity = await describeWasmModuleIdentity(response.clone());
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return {
        module: await WebAssembly.compileStreaming(response.clone()),
        wasmUrl: String(url),
        ...identity,
      };
    } catch (_streamingError) {
      // Fallback for runtimes/servers that do not satisfy streaming compile constraints.
    }
  }
  const bytes = await response.arrayBuffer();
  return {
    module: await WebAssembly.compile(bytes),
    wasmUrl: String(url),
    ...identity,
  };
}

export function normalizeRuntimeMounts(mounts: unknown): string[] {
  if (!Array.isArray(mounts) || mounts.length === 0) {
    throw new TypeError("runtimeMounts must be a non-empty array of guest paths");
  }
  return mounts.map((mountPath: unknown) =>
    normalizeGuestPath(String(mountPath), {
      label: "runtime mount guest path",
    }),
  );
}
