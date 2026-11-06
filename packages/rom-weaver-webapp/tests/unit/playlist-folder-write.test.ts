import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ records: new Map<string, unknown>() }));

vi.mock("../../src/storage/browser/idb-object-store.ts", () => ({
  createIdbObjectStore: () => ({
    open: () => Promise.reject(new Error("unused")),
    transaction: async (_mode: string, action: (store: unknown) => { result: unknown }) =>
      action({
        delete: (key: string) => ({ result: memory.records.delete(key) }),
        // Kept as is: the real store clones directory handles, which a test double cannot be.
        get: (key: string) => ({ result: memory.records.get(key) }),
        put: (value: unknown, key: string) => {
          memory.records.set(key, value);
          return { result: key };
        },
      }).result,
  }),
}));

import {
  readInterruptedPlaylistRename,
  renamePlaylistFolder,
  savePlaylistToFolder,
  undoInterruptedPlaylistRename,
} from "../../src/storage/browser/playlist-folder-write.ts";

type FakeFile = { bytes: Uint8Array<ArrayBuffer>; lastModified: number };
type Fault = (operation: "move" | "write", name: string) => boolean;

const fold = (name: string) => name.normalize("NFC").toLowerCase();
const decoder = new TextDecoder();

/** A picked folder. Like Chrome on Windows and macOS it can match names ignoring case, and its
 * move() replaces an existing destination. */
class FakeFolder {
  readonly files = new Map<string, FakeFile>();
  fault: Fault = () => false;
  constructor(
    readonly name: string,
    readonly caseInsensitive: boolean,
    seed: Record<string, string>,
  ) {
    for (const [file, text] of Object.entries(seed)) this.files.set(file, this.file(text));
  }
  private file(text: string): FakeFile {
    return { bytes: new TextEncoder().encode(text), lastModified: 1000 };
  }
  find(name: string) {
    if (this.files.has(name)) return name;
    return this.caseInsensitive ? [...this.files.keys()].find((key) => fold(key) === fold(name)) : undefined;
  }
  text(name: string) {
    const file = this.files.get(name);
    return file ? decoder.decode(file.bytes) : undefined;
  }
  snapshot() {
    return Object.fromEntries([...this.files.entries()].map(([name, file]) => [name, decoder.decode(file.bytes)]));
  }
  handle(name: string): FileSystemFileHandle {
    let current = name;
    return {
      kind: "file",
      get name() {
        return current;
      },
      getFile: async () => {
        const key = this.find(current);
        const file = key ? this.files.get(key) : undefined;
        if (!(key && file)) throw new DOMException("gone", "NotFoundError");
        return new File([file.bytes], key, { lastModified: file.lastModified });
      },
      createWritable: async () => {
        const parts: Blob[] = [];
        return {
          write: async (data: Blob) => {
            if (this.fault("write", current)) throw new Error(`disk refused ${current}`);
            parts.push(data);
          },
          close: async () => {
            const key = this.find(current) ?? current;
            this.files.set(key, { bytes: new Uint8Array(await new Blob(parts).arrayBuffer()), lastModified: 2000 });
          },
          abort: async () => {
            parts.length = 0;
          },
        };
      },
      move: async (next: string) => {
        if (this.fault("move", current)) throw new Error(`disk refused moving ${current}`);
        const key = this.find(current);
        const file = key ? this.files.get(key) : undefined;
        if (!(key && file)) throw new DOMException("gone", "NotFoundError");
        this.files.delete(key);
        const existing = this.find(next);
        if (existing) this.files.delete(existing);
        this.files.set(next, file);
        current = next;
      },
    } as unknown as FileSystemFileHandle;
  }
  async *list() {
    // A copy of the names, so a move while listing does not change what is listed.
    for (const name of Array.from(this.files.keys())) yield this.handle(name);
  }
  directory(): FileSystemDirectoryHandle {
    return {
      kind: "directory",
      name: this.name,
      values: () => this.list(),
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        const key = this.find(name);
        if (key) return this.handle(key);
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        this.files.set(name, { bytes: new Uint8Array(), lastModified: 2000 });
        return this.handle(name);
      },
      removeEntry: async (name: string) => {
        const key = this.find(name);
        if (!key) throw new DOMException("missing", "NotFoundError");
        this.files.delete(key);
      },
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
    } as unknown as FileSystemDirectoryHandle;
  }
}

const sheet = (track: string) => `FILE "${track}" BINARY\n  TRACK 01 MODE2/2352\n`;

const ff7Folder = (caseInsensitive = true) =>
  new FakeFolder("FF7", caseInsensitive, {
    "ff7.disc01.cue": sheet("ff7.disc01.bin"),
    "ff7.disc01.bin": "disc one",
    "ff7.disc01.sbi": "libcrypt",
    "notes.txt": "keep",
  });

const ff7Request = (folder: FakeFolder) => ({
  directory: folder.directory(),
  planned: new Map(
    ["ff7.disc01.cue", "ff7.disc01.bin", "ff7.disc01.sbi"].map((name) => [
      name,
      { lastModified: 1000, size: folder.files.get(name)?.bytes.byteLength ?? 0 },
    ]),
  ),
  playlist: { fileName: "Final Fantasy VII.m3u", text: "Final Fantasy VII (Disc 1).cue\n" },
  renames: [
    { from: "ff7.disc01.cue", text: sheet("Final Fantasy VII (Disc 1).bin"), to: "Final Fantasy VII (Disc 1).cue" },
    { from: "ff7.disc01.bin", to: "Final Fantasy VII (Disc 1).bin" },
    { from: "ff7.disc01.sbi", to: "Final Fantasy VII (Disc 1).sbi" },
  ],
});

let held = false;

beforeEach(() => {
  memory.records.clear();
  held = false;
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({});
        } finally {
          held = false;
        }
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renamePlaylistFolder", () => {
  it("renames the discs, rewrites their sheets, and writes the playlist", async () => {
    const folder = ff7Folder();
    await renamePlaylistFolder(ff7Request(folder));
    expect(folder.snapshot()).toEqual({
      "Final Fantasy VII (Disc 1).bin": "disc one",
      "Final Fantasy VII (Disc 1).cue": sheet("Final Fantasy VII (Disc 1).bin"),
      "Final Fantasy VII (Disc 1).sbi": "libcrypt",
      "Final Fantasy VII.m3u": "Final Fantasy VII (Disc 1).cue\n",
      "notes.txt": "keep",
    });
    expect(memory.records.size).toBe(0);
  });

  it("swaps names and changes only their case without losing a file", async () => {
    const folder = new FakeFolder("G", true, { "a.chd": "A", "b.chd": "B", "game.chd": "G" });
    const planned = new Map(["a.chd", "b.chd", "game.chd"].map((name) => [name, { lastModified: 1000, size: 1 }]));
    await renamePlaylistFolder({
      directory: folder.directory(),
      planned,
      playlist: { fileName: "G.m3u", text: "b.chd\n" },
      renames: [
        { from: "a.chd", to: "b.chd" },
        { from: "b.chd", to: "a.chd" },
        { from: "game.chd", to: "Game.chd" },
      ],
    });
    expect(folder.snapshot()).toEqual({ "G.m3u": "b.chd\n", "Game.chd": "G", "a.chd": "B", "b.chd": "A" });
  });

  it.each([true, false])("refuses a name another file has (ignoring case: %s)", async (caseInsensitive) => {
    const folder = ff7Folder(caseInsensitive);
    folder.files.set(caseInsensitive ? "final fantasy vii (disc 1).BIN" : "Final Fantasy VII (Disc 1).bin", {
      bytes: new TextEncoder().encode("other game"),
      lastModified: 1000,
    });
    const before = folder.snapshot();
    await expect(renamePlaylistFolder(ff7Request(folder))).rejects.toThrow("already exists");
    expect(folder.snapshot()).toEqual(before);
  });

  it("refuses an existing playlist that differs only in case", async () => {
    const folder = ff7Folder();
    folder.files.set("FINAL FANTASY VII.M3U", { bytes: new Uint8Array([1]), lastModified: 1000 });
    const before = folder.snapshot();
    await expect(renamePlaylistFolder(ff7Request(folder))).rejects.toThrow('"FINAL FANTASY VII.M3U" already exists');
    expect(folder.snapshot()).toEqual(before);
  });

  it("refuses a file that changed after the preview", async () => {
    const folder = ff7Folder();
    const request = ff7Request(folder);
    folder.files.set("ff7.disc01.bin", { bytes: new TextEncoder().encode("edited"), lastModified: 1500 });
    const before = folder.snapshot();
    await expect(renamePlaylistFolder(request)).rejects.toThrow('"ff7.disc01.bin" changed after the preview');
    expect(folder.snapshot()).toEqual(before);
  });

  it.each([
    ["the first move", "move", "ff7.disc01.cue"],
    ["a later move", "move", "ff7.disc01.sbi"],
    ["a move to the final name", "move", ".rw-"],
    ["the sheet rewrite", "write", "Final Fantasy VII (Disc 1).cue"],
    ["the playlist", "write", "Final Fantasy VII.m3u"],
  ])("puts the folder back when %s fails", async (_label, operation, name) => {
    const folder = ff7Folder();
    const before = folder.snapshot();
    let failed = false;
    folder.fault = (op, current) => {
      if (failed || op !== operation || !current.includes(name)) return false;
      failed = true;
      return true;
    };
    await expect(renamePlaylistFolder(ff7Request(folder))).rejects.toThrow("The folder was put back as it was.");
    expect(failed).toBe(true);
    expect(folder.snapshot()).toEqual(before);
    expect(memory.records.size).toBe(0);
  });

  it("keeps a journal when the rollback fails and undoes it later", async () => {
    const folder = ff7Folder();
    const before = folder.snapshot();
    let undoBlocked = true;
    folder.fault = (op, current) =>
      (op === "write" && current === "Final Fantasy VII.m3u") ||
      (undoBlocked && op === "move" && current.includes(".rw-") && current.includes("sbi"));
    await expect(renamePlaylistFolder(ff7Request(folder))).rejects.toThrow("could not rename");
    const interrupted = await readInterruptedPlaylistRename();
    expect(interrupted?.folderName).toBe("FF7");
    await expect(renamePlaylistFolder(ff7Request(folder))).rejects.toThrow("Undo the interrupted rename");
    undoBlocked = false;
    folder.fault = () => false;
    if (!interrupted) throw new Error("expected an interrupted rename");
    await undoInterruptedPlaylistRename(interrupted);
    expect(folder.snapshot()).toEqual(before);
    expect(await readInterruptedPlaylistRename()).toBeNull();
  });

  it("refuses to run while another rename holds the folder lock", async () => {
    const folder = ff7Folder();
    held = true;
    await expect(renamePlaylistFolder(ff7Request(folder))).rejects.toThrow("Another rom-weaver tab");
  });
});

describe("savePlaylistToFolder", () => {
  it("writes a new playlist and never replaces one that differs only in case", async () => {
    const folder = ff7Folder();
    await savePlaylistToFolder(folder.directory(), "FF7.m3u", "ff7.disc01.cue\n");
    expect(folder.text("FF7.m3u")).toBe("ff7.disc01.cue\n");
    await expect(savePlaylistToFolder(folder.directory(), "ff7.M3U", "other\n")).rejects.toThrow(
      '"FF7.m3u" already exists',
    );
    expect(folder.text("FF7.m3u")).toBe("ff7.disc01.cue\n");
  });
});
