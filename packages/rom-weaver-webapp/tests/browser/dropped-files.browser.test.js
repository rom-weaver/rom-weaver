import { expect, test } from "vitest";
import { readDataTransferFiles } from "../../src/lib/input/dropped-files.ts";

const file = (name) => new File([], name);
const names = (files) => files.map((entry) => entry.name);

// Minimal fakes for the directory-entry API so traversal can be tested without
// a real drag-and-drop (which can't be synthesized with directory entries).
const fileEntry = (name) => ({
  file: (resolve) => resolve(file(name)),
  isDirectory: false,
  isFile: true,
  name,
});

const directoryEntry = (name, children) => ({
  createReader: () => {
    let drained = false;
    return {
      readEntries: (resolve) => {
        // Real readers yield children in batches and signal completion with an
        // empty batch; emulate that with a single batch then empty.
        if (drained) {
          resolve([]);
          return;
        }
        drained = true;
        resolve(children);
      },
    };
  },
  isDirectory: true,
  isFile: false,
  name,
});

const entryTransfer = (entries) => ({
  files: [],
  items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
});

test("recurses dropped folders into a flat file list", async () => {
  const transfer = entryTransfer([
    fileEntry("top.sfc"),
    directoryEntry("disc", [fileEntry("track1.bin"), directoryEntry("nested", [fileEntry("inner.sfc")])]),
  ]);
  const files = await readDataTransferFiles(transfer);
  expect(names(files).sort()).toEqual(["inner.sfc", "top.sfc", "track1.bin"]);
});

test("skips hidden files and directories during traversal", async () => {
  const transfer = entryTransfer([
    fileEntry("game.sfc"),
    fileEntry(".DS_Store"),
    directoryEntry(".git", [fileEntry("config")]),
  ]);
  const files = await readDataTransferFiles(transfer);
  expect(names(files)).toEqual(["game.sfc"]);
});

test("falls back to the flat file list when directory entries are unavailable", async () => {
  const transfer = {
    files: [file("game.sfc"), file(".DS_Store")],
    items: [{ kind: "file" }],
  };
  const files = await readDataTransferFiles(transfer);
  expect(names(files)).toEqual(["game.sfc"]);
});

test("returns an empty list for a null transfer", async () => {
  expect(await readDataTransferFiles(null)).toEqual([]);
});

test("reads exact bytes from a browser-created file transfer", async () => {
  const expected = new Uint8Array([1, 2, 3, 4]);
  const transfer = new DataTransfer();
  transfer.items.add(new File([expected], "first.gba"));
  const files = await readDataTransferFiles(transfer);
  expect(names(files)).toEqual(["first.gba"]);
  expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(expected);
});

test("captures a failed file entry's fallback before the transfer clears", async () => {
  const direct = new File([new Uint8Array([5, 6, 7])], "direct.bin");
  let available = direct;
  const failed = {
    file: (_resolve, reject) => queueMicrotask(() => reject(new DOMException("Missing path", "NotFoundError"))),
    isDirectory: false,
    isFile: true,
    name: direct.name,
  };
  const transfer = entryTransfer([fileEntry("first.bin"), failed, directoryEntry("folder", [fileEntry("nested.bin")])]);
  transfer.items[1].getAsFile = () => available;
  const result = readDataTransferFiles(transfer);
  available = null;
  const files = await result;
  expect(names(files)).toEqual(["first.bin", "direct.bin", "nested.bin"]);
  expect(files[1]).toBe(direct);
  expect(new Uint8Array(await files[1].arrayBuffer())).toEqual(new Uint8Array([5, 6, 7]));
});

test("does not duplicate readable entries or recover hidden entries", async () => {
  const visible = fileEntry("visible.bin");
  const hidden = { ...fileEntry(".hidden"), file: (_resolve, reject) => reject(new Error("unreadable")) };
  const transfer = entryTransfer([visible, hidden]);
  transfer.items[0].getAsFile = () => file("visible.bin");
  transfer.items[1].getAsFile = () => file("fallback.bin");
  expect(names(await readDataTransferFiles(transfer))).toEqual(["visible.bin"]);
});
