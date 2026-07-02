import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { describe, expect, it } from "vitest";
import { BrowserOpfsMount } from "../../src/wasm/browser-opfs-mount.ts";
import type { OpfsProxyClient } from "../../src/wasm/browser-opfs-proxy-client.ts";
import type { FileSystemDirectoryHandleLike } from "../../src/wasm/browser-opfs-runtime-types.ts";
import type { RandomAccessFileLike } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";
import { WasiRandomAccessFileInode } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";

// Minimal RandomAccessFileLike that only tracks whether it was closed; the mount-pruning path under
// test never touches the read/write surface.
class StubFile implements RandomAccessFileLike {
  closed = false;
  readAt(): number {
    return 0;
  }
  writeAt(): number {
    return 0;
  }
  size(): number {
    return 0;
  }
  truncate(): void {
    // no-op: pruning path under test never truncates
  }
  flush(): void {
    // no-op: pruning path under test never flushes
  }
  close(): void {
    this.closed = true;
  }
}

function makeMount(baseInputs: { file: StubFile; name: string }[]) {
  const contents = new Map<string, wasiShim.Inode>();
  const ownedFiles: RandomAccessFileLike[] = [];
  for (const { name, file } of baseInputs) {
    contents.set(name, new WasiRandomAccessFileInode(file, { readonly: true }));
    ownedFiles.push(file);
  }
  return new BrowserOpfsMount({
    contents,
    directoryHandle: {} as unknown as FileSystemDirectoryHandleLike,
    mountPath: "/work",
    ownedFiles,
    proxyClient: {} as unknown as OpfsProxyClient,
    virtualOnly: false,
    writableRoots: ["/work"],
  });
}

describe("BrowserOpfsMount per-run adapter pruning", () => {
  it("closes and evicts per-run output/hydrated adapters in finishRun, keeping the persistent input set", () => {
    const baseFile = new StubFile();
    const mount = makeMount([{ file: baseFile, name: "rom.bin" }]);
    expect(mount.persistentOwnedFileCount).toBe(1);

    mount.startRun({ runCloseables: [] });

    // Simulate a run: a preopened output at the top level and a hydrated input nested in a directory.
    const outputFile = new StubFile();
    mount.contents.set("out.cue", new WasiRandomAccessFileInode(outputFile));
    mount.trackOwnedFile(outputFile);

    const subdir = new wasiShim.Directory(new Map());
    mount.contents.set("nested", subdir);
    const hydratedFile = new StubFile();
    subdir.contents.set("track.bin", new WasiRandomAccessFileInode(hydratedFile, { readonly: true }));
    mount.trackOwnedFile(hydratedFile);

    expect(mount.ownedFiles).toHaveLength(3);

    mount.finishRun();

    // Per-run adapters closed and removed; the persistent input survives and stays open.
    expect(outputFile.closed).toBe(true);
    expect(hydratedFile.closed).toBe(true);
    expect(baseFile.closed).toBe(false);
    expect(mount.ownedFiles).toEqual([baseFile]);
    expect(mount.contents.has("out.cue")).toBe(false);
    expect(subdir.contents.has("track.bin")).toBe(false);
    expect(mount.contents.has("rom.bin")).toBe(true);
  });

  it("does not accumulate handles across reused runs", () => {
    const baseFile = new StubFile();
    const mount = makeMount([{ file: baseFile, name: "rom.bin" }]);
    const perRunFiles: StubFile[] = [];

    for (let run = 0; run < 2000; run += 1) {
      mount.startRun({ runCloseables: [] });
      const output = new StubFile();
      perRunFiles.push(output);
      mount.contents.set(`out-${run}.bin`, new WasiRandomAccessFileInode(output));
      mount.trackOwnedFile(output);
      // ownedFiles holds the persistent input plus only this run's single output.
      expect(mount.ownedFiles).toHaveLength(2);
      mount.finishRun();
      expect(output.closed).toBe(true);
    }

    expect(mount.ownedFiles).toEqual([baseFile]);
    expect([...mount.contents.keys()]).toEqual(["rom.bin"]);
    expect(perRunFiles.every((file) => file.closed)).toBe(true);
  });

  it("closes the persistent input set only on dispose", () => {
    const baseFile = new StubFile();
    const mount = makeMount([{ file: baseFile, name: "rom.bin" }]);
    mount.startRun({ runCloseables: [] });
    mount.finishRun();
    expect(baseFile.closed).toBe(false);

    mount.dispose();
    expect(baseFile.closed).toBe(true);
    expect(mount.ownedFiles).toEqual([]);
  });
});
