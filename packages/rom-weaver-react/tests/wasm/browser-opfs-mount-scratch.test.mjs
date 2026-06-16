import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCRATCH_DIRECTORY_NAME } from "../../src/wasm/browser-opfs-constants.ts";
import { BrowserOpfsMount } from "../../src/wasm/browser-opfs-mount.ts";

// The OPFS scratch pool (`.rom-weaver-opfs-scratch`) is per-runner backing storage handed to the guest
// as pre-opened fds, never resolved by guest path. Concurrent runners share one OPFS root, so if the
// scratch dir were enumerated into the wasm-visible `/work` tree, a sibling runner's 0-byte scratch
// placeholder would leak into this run's extract output scan and surface as a phantom empty ROM
// candidate. buildOpfsInodeMap (exercised here via BrowserOpfsMount.create) must skip it at every level.
// No real files are placed in the fixture: a real file would require a worker-only sync access handle,
// while directories (and the skipped scratch dir) build without one, keeping this a main-thread test.

const MOUNT_PATH = "/work";

let root;
let fixtureName;
let fixtureHandle;

const createDir = async (parent, name) => parent.getDirectoryHandle(name, { create: true });

const createEmptyFile = async (parent, name) => {
  const fileHandle = await parent.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.close();
};

beforeEach(async () => {
  root = await navigator.storage.getDirectory();
  fixtureName = `rom-weaver-mount-scratch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fixtureHandle = await root.getDirectoryHandle(fixtureName, { create: true });
});

afterEach(async () => {
  if (!(root && fixtureName)) return;
  await root.removeEntry(fixtureName, { recursive: true }).catch(() => undefined);
  root = undefined;
  fixtureName = undefined;
  fixtureHandle = undefined;
});

describe("buildOpfsInodeMap scratch-pool exclusion", () => {
  it("omits the scratch pool directory from the mount's wasm-visible tree", async () => {
    // A stray scratch placeholder at the mount root, exactly as a sibling runner's pool seeds it.
    const scratchDir = await createDir(fixtureHandle, SCRATCH_DIRECTORY_NAME);
    await createEmptyFile(scratchDir, "abc123-15.tmp");
    // A genuine output directory that must still be enumerated.
    await createDir(fixtureHandle, "payloads");

    const mount = await BrowserOpfsMount.create({
      directoryHandle: fixtureHandle,
      mountPath: MOUNT_PATH,
      writableRoots: [MOUNT_PATH],
    });
    try {
      expect(mount.contents.has(SCRATCH_DIRECTORY_NAME)).toBe(false);
      expect(mount.contents.has("payloads")).toBe(true);
    } finally {
      await mount.dispose();
    }
  });

  it("omits scratch pool directories nested below the mount root", async () => {
    const outputDir = await createDir(fixtureHandle, "out");
    // A scratch dir can appear under any directory the extract writes into, so the skip must apply at
    // every recursion level, not only at the root.
    const nestedScratch = await createDir(outputDir, SCRATCH_DIRECTORY_NAME);
    await createEmptyFile(nestedScratch, "def456-7.tmp");
    await createDir(outputDir, "keep");

    const mount = await BrowserOpfsMount.create({
      directoryHandle: fixtureHandle,
      mountPath: MOUNT_PATH,
      writableRoots: [MOUNT_PATH],
    });
    try {
      const outInode = mount.contents.get("out");
      expect(outInode).toBeTruthy();
      expect(outInode.contents.has(SCRATCH_DIRECTORY_NAME)).toBe(false);
      expect(outInode.contents.has("keep")).toBe(true);
    } finally {
      await mount.dispose();
    }
  });
});
