import { describe, expect, it } from "vitest";
import { classifyArchiveBucket } from "../../src/public/react/file-classification.ts";

describe("archive leaf classification", () => {
  it.each([
    [["nested/original.bin"], "rom"],
    [["nested/fix.ips"], "patch"],
    [["nested/rom-weaver-weave.json"], "patch"],
    [["nested/original.bin", "nested/fix.ips"], "rom"],
    [["unreadable.zip"], "rom"],
  ] as const)("routes %j to %s", (names, bucket) => {
    expect(classifyArchiveBucket({ name: "nested.zip" }, names)).toBe(bucket);
  });
});
