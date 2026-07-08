import { expect, test } from "vitest";
import { createBrowserRuntimeVfsIo } from "../../src/platform/browser/browser-runtime-vfs.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";

// browser-runtime-vfs stages each dropped source as a read-only, Blob-backed virtual file. A single
// input load stages the same source for several passes (probe -> listings -> extract); those passes can
// overlap. The resolved-entry cache dedupes a *sequential* re-stage, but a second pass that begins
// before the first finishes staging used to run its own stage and — because the first copy still held
// the bare visible name — be handed `name-2.ext`. Codec/disc extractors name outputs from the staged
// stem, so that surfaced as a phantom `-2` extraction with no base file. Concurrent same-source stages
// must now coalesce onto one bare-named copy.
const stubVfs = /** @type {never} */ ({
  hostKind: "browser-opfs",
  remove: async () => undefined,
  rootPath: "/work",
  stat: async () => null,
});

const stageRequest = (file) => ({
  fallbackFileName: "game.bin",
  pathPrefix: "ingest-input",
  scope: "archive",
  source: file,
});

// A FileSystemFileHandle-like source: browser-runtime-vfs stages it through the virtual-file path (same
// bare "/work/game.bin" name as a File), and getFile is the seam we drive to fail or gate a stage. The
// same object instance is reused across passes so it resolves to one content key (object identity).
const makeHandle = (getFile) => ({ getFile, kind: "file", name: "game.bin" });
const gameFile = () => new File([new Uint8Array([1, 2, 3, 4])], "game.bin", { type: "application/octet-stream" });

test("concurrent stages of the same source coalesce onto one bare-named copy (no -2)", async () => {
  const io = createBrowserRuntimeVfsIo({ mountPoint: "/work", vfs: stubVfs });
  const file = new File([new Uint8Array([1, 2, 3, 4])], "game.bin", { type: "application/octet-stream" });

  // Fire both stages without awaiting between them, mirroring overlapping ingest passes of one drop.
  const [first, second] = await Promise.all([io.stageSource(stageRequest(file)), io.stageSource(stageRequest(file))]);

  try {
    // Both passes share the single staged copy at the bare name; neither climbs to game-2.bin.
    expect(first.filePath).toBe("/work/game.bin");
    expect(second.filePath).toBe("/work/game.bin");
    // Coalesced, not double-staged: exactly one virtual file is registered for the source.
    expect(getActiveBrowserVirtualFiles().map((entry) => entry.path)).toEqual(["/work/game.bin"]);
  } finally {
    // releaseSources cleans the shared staged copy immediately (bypassing the retention timer) so no
    // virtual file or pending timer leaks into sibling tests.
    await io.releaseSources([file]);
  }
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

// Guards 7d3e95f8: several passes waking from the SAME failed in-flight stage must coalesce onto the one
// retry the first waker starts, not each spawn a duplicate stage (game-2/-3/-4.bin). Reverting the
// coalesce `while` loop to a single check silently reintroduces the `-2` phantom under 3+ waiters.
test("a failed first stage coalesces its waiters onto one retry (no -2)", async () => {
  const io = createBrowserRuntimeVfsIo({ mountPoint: "/work", vfs: stubVfs });
  let getFileCalls = 0;
  // First stage attempt throws; every later attempt succeeds — so a duplicate retry would show up as a
  // second successful stage (extra getFile call + a game-2.bin virtual file).
  const handle = makeHandle(async () => {
    getFileCalls += 1;
    if (getFileCalls === 1) throw new Error("first stage boom");
    return gameFile();
  });
  const req = () => ({ fallbackFileName: "game.bin", pathPrefix: "ingest-input", scope: "archive", source: handle });

  // Four overlapping passes of one drop: the first stages (and fails); the other three wake from that
  // failure and must fold onto a single retry.
  const results = await Promise.allSettled([
    io.stageSource(req()),
    io.stageSource(req()),
    io.stageSource(req()),
    io.stageSource(req()),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  try {
    expect(rejected.length).toBe(1);
    expect(fulfilled.length).toBe(3);
    // Exactly one failed stage plus exactly one retry — not one retry per waiter.
    expect(getFileCalls).toBe(2);
    // All three survivors share the single bare-named retry copy; none climbs to game-2.bin.
    expect(fulfilled.every((result) => result.value.filePath === "/work/game.bin")).toBe(true);
    expect(getActiveBrowserVirtualFiles().map((entry) => entry.path)).toEqual(["/work/game.bin"]);
  } finally {
    await Promise.all(fulfilled.map((result) => result.value.cleanup().catch(() => undefined)));
    await io.releaseSources([handle]);
  }
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

// Guards finding 1(a): a release that lands while a stage is still in flight (not yet cached) must not
// clean the fresh copy out from under the live consumer that requested it. The staged path stays
// registered until that consumer releases its own ref.
test("a release during an in-flight stage defers to the staging consumer (path stays registered)", async () => {
  const io = createBrowserRuntimeVfsIo({ mountPoint: "/work", vfs: stubVfs });
  let openGate = () => undefined;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const handle = makeHandle(async () => {
    await gate;
    return gameFile();
  });
  const req = () => ({ fallbackFileName: "game.bin", pathPrefix: "ingest-input", scope: "archive", source: handle });

  // Stage suspends inside getFile with its pendingStages entry published (in flight, not yet cached).
  const staging = io.stageSource(req());
  // A stale session release of the same source arrives mid-flight; it must not destroy this stage's copy.
  await io.releaseSources([handle]);
  openGate();
  const staged = await staging;

  try {
    expect(staged.filePath).toBe("/work/game.bin");
    // The in-flight release did not clean the fresh copy: the consumer can still read it.
    expect(getActiveBrowserVirtualFiles().map((entry) => entry.path)).toEqual(["/work/game.bin"]);
  } finally {
    await staged.cleanup();
  }
  // Once the consumer releases, the deferred cleanup runs.
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

// Guards finding 1(b): a stale releaseSources from an earlier drop must not force-clean an idle cached
// copy that a concurrent cross-drop re-stage just picked up as a live reader.
test("releaseSources defers to a concurrent cross-drop re-stage (no clobber under a live reader)", async () => {
  const io = createBrowserRuntimeVfsIo({ mountPoint: "/work", vfs: stubVfs });
  const file = gameFile();

  // First drop stages and fully releases, leaving an idle cached copy under the retention timer.
  const firstDrop = await io.stageSource(stageRequest(file));
  await firstDrop.cleanup();
  expect(getActiveBrowserVirtualFiles().map((entry) => entry.path)).toEqual(["/work/game.bin"]);

  // The prior drop's session releases the same File at the same time a new drop re-stages it. The
  // re-stage reuses the idle copy; the stale release must not force-clean it out from under the new reader.
  const [reStaged] = await Promise.all([io.stageSource(stageRequest(file)), io.releaseSources([file])]);

  try {
    expect(reStaged.filePath).toBe("/work/game.bin");
    // Survived the concurrent release: still registered while the new reader holds it.
    expect(getActiveBrowserVirtualFiles().map((entry) => entry.path)).toEqual(["/work/game.bin"]);
  } finally {
    await reStaged.cleanup();
  }
  // Once the new reader releases, the deferred cleanup runs.
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
