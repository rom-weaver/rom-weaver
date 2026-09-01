import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileSystemDirectoryHandleLike } from "../../src/wasm/browser-opfs-runtime-types.ts";
import {
  assertDedicatedWorkerRuntime,
  assertDirectoryHandle,
  canUseThreadedWasmRuntime,
  normalizeRuntimeMounts,
  resolveBrowserModule,
  verifyWritableOpfsRoot,
} from "../../src/wasm/browser-opfs-runtime-env.ts";

/** The smallest byte sequence WebAssembly.compile accepts: the magic number plus version. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

type FakeResponse = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  clone: () => FakeResponse;
  ok: boolean;
  status: number;
  statusText: string;
};

function makeResponse(overrides: Partial<FakeResponse> = {}): FakeResponse {
  const response: FakeResponse = {
    arrayBuffer: async () => EMPTY_WASM.slice().buffer,
    clone: () => response,
    ok: true,
    status: 200,
    statusText: "OK",
    ...overrides,
  };
  return response;
}

async function expectedShaPrefix(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

let wasmModule: WebAssembly.Module;

beforeEach(async () => {
  wasmModule = await WebAssembly.compile(EMPTY_WASM);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveBrowserModule with a supplied module", () => {
  it("returns the module untouched and reports no identity", async () => {
    const resolved = await resolveBrowserModule({ module: wasmModule });

    expect(resolved).toEqual({ module: wasmModule, wasmByteLength: null, wasmSha: "", wasmUrl: null });
  });

  it("keeps a configured url alongside the supplied module", async () => {
    expect((await resolveBrowserModule({ module: wasmModule, wasmUrl: "/custom.wasm" })).wasmUrl).toBe("/custom.wasm");
    expect(
      (await resolveBrowserModule({ module: wasmModule, wasmUrl: new URL("https://x.test/a.wasm") })).wasmUrl,
    ).toBe("https://x.test/a.wasm");
    expect((await resolveBrowserModule({ module: wasmModule, wasmUrl: "   " })).wasmUrl).toBeNull();
  });
});

describe("resolveBrowserModule compiling from a url", () => {
  it("streams the compile and reports the byte length and sha prefix", async () => {
    const response = makeResponse();
    const fetchSpy = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchSpy);
    const streaming = vi.spyOn(WebAssembly, "compileStreaming").mockImplementation(async () => wasmModule);

    const resolved = await resolveBrowserModule({ wasmUrl: "/app.wasm" });

    expect(fetchSpy).toHaveBeenCalledWith("/app.wasm");
    expect(streaming).toHaveBeenCalledTimes(1);
    expect(resolved.module).toBe(wasmModule);
    expect(resolved.wasmUrl).toBe("/app.wasm");
    expect(resolved.wasmByteLength).toBe(EMPTY_WASM.byteLength);
    expect(resolved.wasmSha).toBe(await expectedShaPrefix(EMPTY_WASM));
    expect(resolved.wasmSha).toMatch(/^[0-9a-f]{8}$/);
  });

  it("falls back to a buffered compile when streaming is rejected", async () => {
    vi.stubGlobal("fetch", async () => makeResponse());
    vi.spyOn(WebAssembly, "compileStreaming").mockRejectedValue(new Error("bad MIME type"));
    const compile = vi.spyOn(WebAssembly, "compile");

    const resolved = await resolveBrowserModule({ wasmUrl: "/app.wasm" });

    expect(compile).toHaveBeenCalledTimes(1);
    expect(resolved.module).toBeInstanceOf(WebAssembly.Module);
    expect(resolved.wasmUrl).toBe("/app.wasm");
  });

  it("compiles from bytes when the runtime has no streaming compile", async () => {
    vi.stubGlobal("fetch", async () => makeResponse());
    const original = WebAssembly.compileStreaming;
    Reflect.deleteProperty(WebAssembly as unknown as Record<string, unknown>, "compileStreaming");
    try {
      const resolved = await resolveBrowserModule({ wasmUrl: "/app.wasm" });
      expect(resolved.module).toBeInstanceOf(WebAssembly.Module);
    } finally {
      Object.defineProperty(WebAssembly, "compileStreaming", { configurable: true, value: original, writable: true });
    }
  });

  it("reports the http status when the fetch is refused", async () => {
    vi.stubGlobal("fetch", async () => makeResponse({ ok: false, status: 404, statusText: "Not Found" }));

    await expect(resolveBrowserModule({ wasmUrl: "/missing.wasm" })).rejects.toThrow(
      "failed to fetch wasm module from /missing.wasm: 404 Not Found",
    );
  });

  it("surfaces the last failure after every candidate url fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    await expect(resolveBrowserModule({ wasmUrl: "/app.wasm" })).rejects.toThrow("network down");
  });

  it("accepts a URL object as the wasm source", async () => {
    const fetchSpy = vi.fn(async () => makeResponse());
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(wasmModule);

    const resolved = await resolveBrowserModule({ wasmUrl: new URL("https://cdn.test/app.wasm") });

    expect(fetchSpy).toHaveBeenCalledWith("https://cdn.test/app.wasm");
    expect(resolved.wasmUrl).toBe("https://cdn.test/app.wasm");
  });

  it("falls back to the packaged artifact url when none is configured", async () => {
    const fetchSpy = vi.fn(async () => makeResponse());
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(wasmModule);

    const resolved = await resolveBrowserModule();

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("rom-weaver-app.wasm");
    expect(resolved.wasmUrl).toContain("rom-weaver-app.wasm");
  });
});

describe("wasm module identity", () => {
  it("reports an empty identity when the body cannot be read", async () => {
    vi.stubGlobal("fetch", async () =>
      makeResponse({
        arrayBuffer: async () => {
          throw new Error("body already consumed");
        },
      }),
    );
    vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(wasmModule);

    const resolved = await resolveBrowserModule({ wasmUrl: "/app.wasm" });

    expect(resolved.wasmByteLength).toBeNull();
    expect(resolved.wasmSha).toBe("");
  });

  it("still reports the byte length when the runtime exposes no SubtleCrypto", async () => {
    vi.stubGlobal("fetch", async () => makeResponse());
    vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(wasmModule);
    vi.stubGlobal("crypto", {});

    const resolved = await resolveBrowserModule({ wasmUrl: "/app.wasm" });

    expect(resolved.wasmByteLength).toBe(EMPTY_WASM.byteLength);
    expect(resolved.wasmSha).toBe("");
  });
});

describe("canUseThreadedWasmRuntime", () => {
  it("requires SharedArrayBuffer and cross-origin isolation together", () => {
    vi.stubGlobal("crossOriginIsolated", true);
    expect(canUseThreadedWasmRuntime()).toBe(true);

    vi.stubGlobal("crossOriginIsolated", false);
    expect(canUseThreadedWasmRuntime()).toBe(false);

    vi.stubGlobal("crossOriginIsolated", true);
    vi.stubGlobal("SharedArrayBuffer", undefined);
    expect(canUseThreadedWasmRuntime()).toBe(false);
  });
});

describe("assertDedicatedWorkerRuntime", () => {
  it("passes inside a worker-like runtime with sync access handles", () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("FileSystemSyncAccessHandle", class {});

    expect(() => {
      assertDedicatedWorkerRuntime();
    }).not.toThrow();
  });

  it("rejects a runtime with no navigator or no self", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("self", globalThis);
    expect(() => {
      assertDedicatedWorkerRuntime();
    }).toThrow("createRomWeaverBrowserOpfs can only run in a browser runtime");
  });

  it("rejects the main thread", () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("window", {});

    expect(() => {
      assertDedicatedWorkerRuntime();
    }).toThrow(/must run in a Dedicated Worker/);
  });

  it("rejects a worker without FileSystemSyncAccessHandle", () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("FileSystemSyncAccessHandle", undefined);

    expect(() => {
      assertDedicatedWorkerRuntime();
    }).toThrow(/FileSystemSyncAccessHandle is not available in this runtime/);
  });
});

describe("assertDirectoryHandle", () => {
  const handle = {
    entries: () => undefined,
    getDirectoryHandle: () => undefined,
    getFileHandle: () => undefined,
    kind: "directory",
  };

  it("accepts a handle carrying the whole directory surface", () => {
    expect(() => {
      assertDirectoryHandle(handle, "opfsHandle");
    }).not.toThrow();
  });

  it("rejects anything missing a piece of that surface", () => {
    const cases: unknown[] = [
      null,
      "handle",
      { ...handle, kind: "file" },
      { ...handle, entries: undefined },
      { ...handle, getDirectoryHandle: undefined },
      { ...handle, getFileHandle: undefined },
    ];
    for (const candidate of cases) {
      expect(() => {
        assertDirectoryHandle(candidate, "mountHandle");
      }).toThrow("mountHandle must be a FileSystemDirectoryHandle");
    }
  });
});

describe("normalizeRuntimeMounts", () => {
  it("normalizes every mount path", () => {
    expect(normalizeRuntimeMounts(["work", "/cache/", " /tmp "])).toEqual(["/work", "/cache", "/tmp"]);
  });

  it("requires a non-empty array", () => {
    expect(() => normalizeRuntimeMounts([])).toThrow("runtimeMounts must be a non-empty array of guest paths");
    expect(() => normalizeRuntimeMounts("/work")).toThrow("runtimeMounts must be a non-empty array of guest paths");
  });
});

describe("verifyWritableOpfsRoot", () => {
  type ProbeHandle = {
    close: () => void;
    flush: () => void;
    write: (data: Uint8Array, options: { at: number }) => number;
  };

  function makeRoot(
    options: {
      entries?: [string, { kind: string }][];
      onRemove?: (name: string) => void;
      probe?: Partial<ProbeHandle>;
      removeError?: () => unknown;
      withEntries?: boolean;
      withRemove?: boolean;
    } = {},
  ) {
    const written: { at: number; bytes: Uint8Array }[] = [];
    const removed: string[] = [];
    const root: Record<string, unknown> = {
      getFileHandle: vi.fn(async () => ({
        createSyncAccessHandle: async () => ({
          close: () => undefined,
          flush: () => undefined,
          write: (bytes: Uint8Array, at: { at: number }) => {
            written.push({ at: at.at, bytes });
            return bytes.byteLength;
          },
          ...options.probe,
        }),
      })),
      kind: "directory",
    };
    if (options.withEntries !== false) {
      root.entries = async function* entries() {
        yield* options.entries ?? [];
      };
    }
    if (options.withRemove !== false) {
      root.removeEntry = vi.fn(async (name: string) => {
        removed.push(name);
        options.onRemove?.(name);
        const error = options.removeError?.();
        if (error) throw error;
      });
    }
    return { removed, root: root as unknown as FileSystemDirectoryHandleLike, written };
  }

  it("writes and removes a probe file to prove the root is writable", async () => {
    const { removed, root, written } = makeRoot();

    await verifyWritableOpfsRoot(root);

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ at: 0 });
    expect(written[0]?.bytes).toEqual(new Uint8Array([0x52, 0x57]));
    expect(removed).toHaveLength(1);
    expect(removed[0]?.startsWith(".rw-probe-")).toBe(true);
  });

  it("removes stale probes first and leaves fresh ones and non-probes alone", async () => {
    const stale = `.rw-probe-${Date.now() - 120_000}-old`;
    const { removed, root } = makeRoot({
      entries: [
        [stale, { kind: "file" }],
        [`.rw-probe-${Date.now()}-fresh`, { kind: "file" }],
        [".rw-probe-dir", { kind: "directory" }],
        ["rom.iso", { kind: "file" }],
      ],
    });

    await verifyWritableOpfsRoot(root);

    expect(removed[0]).toBe(stale);
    expect(removed).toHaveLength(2);
  });

  it("skips the stale sweep on a handle with no entries iterator", async () => {
    const { removed, root } = makeRoot({ withEntries: false });

    await verifyWritableOpfsRoot(root);
    expect(removed).toHaveLength(1);
  });

  it("reports a root whose probe cannot be written", async () => {
    const { root } = makeRoot({
      probe: {
        write: () => {
          throw new Error("NotAllowedError");
        },
      },
    });

    await expect(verifyWritableOpfsRoot(root)).rejects.toThrow(
      /OPFS root is not writable with sync access handles: Error: NotAllowedError/,
    );
  });

  it("ignores a probe handle that refuses to close", async () => {
    const { removed, root } = makeRoot({
      probe: {
        close: () => {
          throw new Error("already closed");
        },
      },
    });

    await verifyWritableOpfsRoot(root);
    expect(removed).toHaveLength(1);
  });

  it("tolerates a root with no removeEntry at all", async () => {
    const { root } = makeRoot({ withRemove: false });

    await expect(verifyWritableOpfsRoot(root)).resolves.toBeUndefined();
  });

  it("gives up on a removal error that is not a lock conflict", async () => {
    const { removed, root } = makeRoot({ removeError: () => new Error("gone") });

    await verifyWritableOpfsRoot(root);
    expect(removed).toHaveLength(1);
  });

  it("retries a locked removal until it succeeds", async () => {
    let attempts = 0;
    const { removed, root } = makeRoot({
      removeError: () => {
        attempts += 1;
        if (attempts > 2) return null;
        return Object.assign(new Error("locked"), { name: "NoModificationAllowedError" });
      },
    });

    await verifyWritableOpfsRoot(root);

    expect(attempts).toBe(3);
    expect(removed).toHaveLength(3);
  });

  it("stops retrying a locked removal once the backoff ladder runs out", async () => {
    vi.useFakeTimers();
    const { removed, root } = makeRoot({
      removeError: () => Object.assign(new Error("locked"), { name: "NoModificationAllowedError" }),
    });

    const verified = verifyWritableOpfsRoot(root);
    await vi.advanceTimersByTimeAsync(5000);
    await verified;

    // Six backoff delays plus the attempt that finds none left.
    expect(removed).toHaveLength(7);
  });
});
