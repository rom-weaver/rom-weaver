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
