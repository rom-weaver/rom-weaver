import { describe, expect, it } from "vitest";
import { matchPreferredPatchLeaf } from "../../src/lib/input/input-archive-patch-leaves.ts";

const leaf = (fileName: string) => ({ candidate: { fileName }, file: fileName });
const nameOf = (result: ReturnType<typeof leaf> | undefined) => result?.candidate.fileName;

describe("matchPreferredPatchLeaf", () => {
  it("prefers an exact base-name match, case-insensitively", () => {
    const leaves = [leaf("alternate.ips"), leaf("change.ips")];
    expect(nameOf(matchPreferredPatchLeaf(leaves, "Change.IPS"))).toBe("change.ips");
  });

  it("strips any directory prefix from the preferred name before matching", () => {
    const leaves = [leaf("change.ips")];
    expect(nameOf(matchPreferredPatchLeaf(leaves, "patches/change.ips"))).toBe("change.ips");
  });

  it("falls back to an extension-agnostic stem match", () => {
    const leaves = [leaf("alternate.bps"), leaf("change.bps")];
    expect(nameOf(matchPreferredPatchLeaf(leaves, "change.ips"))).toBe("change.bps");
  });

  it("prefers the exact match over a stem match", () => {
    const leaves = [leaf("change.bps"), leaf("change.ips")];
    expect(nameOf(matchPreferredPatchLeaf(leaves, "change.ips"))).toBe("change.ips");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchPreferredPatchLeaf([leaf("change.ips")], "different.ips")).toBeUndefined();
  });

  it("returns undefined for an empty or missing preferred name", () => {
    const leaves = [leaf("change.ips")];
    expect(matchPreferredPatchLeaf(leaves, "")).toBeUndefined();
    expect(matchPreferredPatchLeaf(leaves, undefined)).toBeUndefined();
  });
});
