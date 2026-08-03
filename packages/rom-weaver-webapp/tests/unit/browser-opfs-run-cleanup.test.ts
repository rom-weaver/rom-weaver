import { describe, expect, it } from "vitest";
import { findEmptyExtractStagingPaths } from "../../src/wasm/browser-opfs-run-cleanup.ts";

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
});
