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
  it("does not list OPFS when there are no retained runs", async () => {
    await cleanupBrowserOpfsRunScratch({ runIds: new Set(), workGuestPath: "/work" });
    expect(requestStorage).not.toHaveBeenCalled();
  });

  it("cleans multiple run namespaces and empty extract trees from one listing", async () => {
    const owned = ["a", "a-b", "550e8400-e29b-41d4-a716-446655440000"];
    const removed = owned.flatMap((runId) => [`/rw-${runId}`, `/op/.rom-weaver-extract-${runId}-0`]);
    requestStorage.mockResolvedValueOnce({
      action: "list-complete",
      success: true,
      entries: [
        ...removed.map((path) => ({ kind: "directory" as const, path })),
        { kind: "directory", path: "/rw-another-1" },
        { kind: "directory", path: "/op/.rom-weaver-extract-a-b-1" },
        { kind: "file", path: "/op/.rom-weaver-extract-a-b-1/nested/data.bin" },
        { kind: "directory", path: "/op/.rom-weaver-extract-another-0" },
      ],
    });
    requestStorage.mockResolvedValue({ action: "remove-complete", success: true });

    await cleanupBrowserOpfsRunScratch({ runIds: new Set(owned), workGuestPath: "/work" });

    expect(requestStorage.mock.calls.filter(([request]) => request.action === "list-metadata")).toHaveLength(1);
    expect(
      requestStorage.mock.calls
        .slice(1)
        .map(([request]) => request.filePath || "")
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(removed.map((path) => `/work${path}`).sort((left, right) => left.localeCompare(right)));
  });

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
      new Set(["run-1"]),
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
        new Set(["run-1"]),
      ),
    ).toEqual([
      "/fixture/rom-weaver-out/rw-run-1-1-a",
      "/fixture/rom-weaver-out/rw-run-1-2-b",
      "/fixture/rom-weaver-out/rw-run-1-old",
    ]);
  });

  it("settles sibling removals before reporting a run scratch failure", async () => {
    let finishSlow: () => void = () => undefined;
    requestStorage.mockResolvedValueOnce({
      action: "list-complete",
      success: true,
      entries: ["failed", "slow"].map((name) => ({ kind: "directory", path: `/rom-weaver-out/rw-run-1-${name}` })),
    });
    requestStorage.mockImplementation(async (request) => {
      if (request.filePath?.endsWith("failed"))
        return { action: "remove-complete", success: false, error: { message: "entry is locked" } };
      return new Promise((resolve) => {
        finishSlow = () => resolve({ action: "remove-complete", success: true });
      });
    });
    let settled = false;
    const pending = cleanupBrowserOpfsRunScratch({ runIds: new Set(["run-1"]), workGuestPath: "/work" });
    const checked = expect(pending).rejects.toThrow("entry is locked");
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(requestStorage).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);
    finishSlow();
    await checked;
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

    await cleanupBrowserOpfsRunScratch({ runIds: new Set(["run-1"]), workGuestPath: "/work" });

    expect(requestStorage).toHaveBeenNthCalledWith(1, { action: "list-metadata" });
    expect(
      requestStorage.mock.calls
        .slice(1)
        .map(([request]) => request.filePath)
        .sort((left, right) => Number(left > right) - Number(left < right)),
    ).toEqual(["/work/fixture/operations/op/.rom-weaver-extract-run-1-0", "/work/fixture/rom-weaver-out/rw-run-1-1-a"]);
  });
});
