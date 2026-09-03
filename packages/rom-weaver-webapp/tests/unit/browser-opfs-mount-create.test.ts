import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { describe, expect, it, vi } from "vitest";

import { BrowserOpfsMount, cleanupBrowserOpfsMounts } from "../../src/wasm/browser-opfs-mount.ts";

const fileHandle = (kind: "file" | "directory") => ({ kind });

const directoryWithEntries = (entries: Array<[string, { kind: string }]>, fail = false) => ({
  async *entries() {
    if (fail) throw new Error("directory disappeared");
    yield* entries;
  },
});

describe("browser OPFS mount construction", () => {
  it("walks files and directories, skips disappearing siblings, and marks writable files", async () => {
    const nested = directoryWithEntries([["track.bin", fileHandle("file")]]);
    const root = {
      async *entries() {
        yield ["read.bin", fileHandle("file")];
        yield ["nested", { kind: "directory", ...nested }];
        yield ["gone", { kind: "directory", ...directoryWithEntries([], true) }];
        yield ["unknown", fileHandle("link")];
      },
    };
    const mount = await BrowserOpfsMount.create({
      directoryHandle: root as never,
      mountPath: "/work",
      proxyClient: {} as never,
      virtualOnly: false,
      writableRoots: ["/work/nested"],
    });
    expect([...mount.contents.keys()]).toEqual(["read.bin", "nested"]);
    expect(mount.ownedFiles).toHaveLength(2);
    expect(mount.isWritablePath("/work/nested/track.bin")).toBe(true);
    expect(mount.isWritablePath("/work/read.bin")).toBe(false);
    cleanupBrowserOpfsMounts([mount]);
    expect(mount.ownedFiles).toHaveLength(2);
  });

  it("creates an empty virtual-only mount and restores virtual files around a run", async () => {
    const mount = await BrowserOpfsMount.create({
      directoryHandle: {} as never,
      mountPath: "/work",
      proxyClient: {} as never,
      syncAccessMode: "proxy" as never,
      virtualOnly: true,
      writableRoots: ["/work"],
    });
    expect(mount.contents).toEqual(new Map());
    const trace = vi.fn();
    mount.startRun({
      runCloseables: [],
      trace,
      virtualFiles: [{ path: "/work/input.bin", source: new Uint8Array([1, 2]) }],
    });
    expect(mount.contents.get("input.bin")).toBeInstanceOf(wasiShim.Inode);
    expect(trace).toHaveBeenCalledWith(expect.stringContaining("virtual files start"));
    mount.finishRun();
    expect(mount.contents).toEqual(new Map());
  });
});
