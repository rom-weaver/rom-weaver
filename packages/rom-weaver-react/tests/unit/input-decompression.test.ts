import { describe, expect, it } from "vitest";
import type { PatchFileInstance } from "../../src/lib/input/binary-service.ts";
import { getActiveExtractTimeMs } from "../../src/lib/input/input-decompression.ts";

describe("getActiveExtractTimeMs", () => {
  it("uses worker-reported extraction time instead of host queue latency", () => {
    const file = { _extractTimeMs: 125 } as unknown as PatchFileInstance;
    expect(getActiveExtractTimeMs(file, 900)).toBe(125);
  });
});
