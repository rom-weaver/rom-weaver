import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestBrowserOpfsStorage } from "../../src/workers/protocol/browser-opfs-worker-client.ts";
import {
  cleanupBrowserOpfsRunScratch,
  findEmptyExtractStagingPaths,
  findRunTempNamespacePaths,
} from "../../src/wasm/browser-opfs-run-cleanup.ts";

vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({
  requestBrowserOpfsStorage: vi.fn(),
}));

const requestStorage = vi.mocked(requestBrowserOpfsStorage);

beforeEach(() => {
  requestStorage.mockReset();
});

describe("browser OPFS run scratch cleanup", () => {
  it("finds only empty extract staging trees owned by the current run", () => {
    const paths = findEmptyExtractStagingPaths(
      [
        { kind: "directory", path: "/operations/op/.rom-weaver-extract-run-1-0" },
        { kind: "directory", path: "/operations/op/.rom-weaver-extract-run-1-0/new" },
        { kind: "directory", path: "/operations/op/.rom-weaver-extract-run-1-0/old" },
        { kind: "directory", path: "/operations/op/.rom-weaver-extract-other-0" },
        { kind: "directory", path: "/operations/op/.rom-weaver-extract-run-1-1" },
        { kind: "file", path: "/operations/op/.rom-weaver-extract-run-1-1/new/0.bin" },
      ],
      "run-1",
    );

    expect(paths).toEqual(["/operations/op/.rom-weaver-extract-run-1-0"]);
  });

  it("finds all unique temp namespaces for the current run", () => {
    expect(
      findRunTempNamespacePaths(
        [
          { kind: "directory", path: "/fixture/rom-weaver-out/rw-run-1-1-a" },
          { kind: "directory", path: "/fixture/rom-weaver-out/rw-run-1-2-b" },
          { kind: "directory", path: "/fixture/rom-weaver-out/rw-run-2-1-a" },
          { kind: "directory", path: "/fixture/rom-weaver-out/rw-run-1-old" },
        ],
        "run-1",
      ),
    ).toEqual([
      "/fixture/rom-weaver-out/rw-run-1-1-a",
      "/fixture/rom-weaver-out/rw-run-1-2-b",
      "/fixture/rom-weaver-out/rw-run-1-old",
    ]);
  });

  it("removes listed scratch paths without assuming the guest mount path", async () => {
    requestStorage.mockResolvedValueOnce({
      action: "list-complete",
      entries: [
        { kind: "directory", path: "/fixture/rom-weaver-out/rw-run-1-1-a" },
        { kind: "directory", path: "/fixture/operations/op/.rom-weaver-extract-run-1-0" },
        { kind: "directory", path: "/fixture/operations/op/.rom-weaver-extract-run-1-1" },
        { kind: "directory", path: "/fixture/operations/op/.rom-weaver-extract-run-1-1/new" },
        { kind: "file", path: "/fixture/operations/op/.rom-weaver-extract-run-1-1/new/0.bin" },
      ],
      success: true,
    });
    requestStorage.mockResolvedValue({ action: "remove-complete", success: true });

    await cleanupBrowserOpfsRunScratch({ runId: "run-1", workGuestPath: "/work" });

    expect(requestStorage).toHaveBeenNthCalledWith(1, { action: "list-metadata" });
    expect(
      requestStorage.mock.calls
        .slice(1)
        .map(([request]) => request.filePath)
        .sort(),
    ).toEqual(["/work/fixture/operations/op/.rom-weaver-extract-run-1-0", "/work/fixture/rom-weaver-out/rw-run-1-1-a"]);
  });
});
