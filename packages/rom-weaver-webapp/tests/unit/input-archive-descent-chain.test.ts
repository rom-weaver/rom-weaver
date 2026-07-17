import { describe, expect, it } from "vitest";
import type { PatchFileInstance } from "../../src/lib/input/binary-service.ts";
import {
  buildDescentParentCompressions,
  type DescentExtractStep,
} from "../../src/lib/input/input-archive-descent-chain.ts";

const file = (fileName: string, fileSize: number) => ({ fileName, fileSize }) as unknown as PatchFileInstance;

describe("buildDescentParentCompressions", () => {
  it("attaches each level's own extract time as decompressionTimeMs", () => {
    const steps: DescentExtractStep[] = [
      {
        depth: 0,
        extractTimeMs: 50,
        format: "7z",
        outDir: "/work/a",
        outputSize: 200,
        source: "/work/outer.7z",
        sourceName: "outer.7z",
      },
      {
        depth: 1,
        extractTimeMs: 30,
        format: "zip",
        outDir: "/work/a/b",
        outputSize: 120,
        source: "/work/a/inner.zip",
        sourceName: "inner.zip",
      },
    ];

    const levels = buildDescentParentCompressions({
      archiveFile: file("outer.7z", 160),
      files: [file("game.bin", 13)],
      outputs: [{ path: "/work/a/b/game.bin" }],
      steps,
    });

    expect(levels.map((level) => [level.fileName, level.decompressionTimeMs])).toEqual([
      ["outer.7z", 50],
      ["inner.zip", 30],
      // The extracted leaf is the product of the deepest level, not an extract step of its own.
      ["game.bin", undefined],
    ]);
  });

  it("omits decompressionTimeMs for a level that reports no extract time", () => {
    const steps: DescentExtractStep[] = [
      {
        depth: 0,
        format: "7z",
        outDir: "/work/x",
        outputSize: 13,
        source: "/work/one-rom.7z",
        sourceName: "one-rom.7z",
      },
    ];

    const levels = buildDescentParentCompressions({
      archiveFile: file("one-rom.7z", 160),
      files: [file("game.bin", 13)],
      outputs: [{ path: "/work/x/game.bin" }],
      steps,
    });

    expect(levels[0]?.fileName).toBe("one-rom.7z");
    expect(levels[0]?.decompressionTimeMs).toBeUndefined();
  });
});
