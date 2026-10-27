import { describe, expect, it } from "vitest";
import { groupNfsFiles } from "../../src/lib/input/nfs-inputs.ts";

const file = (name: string, dir = "") => {
  const value = new File(["x"], name);
  if (dir) Object.defineProperty(value, "webkitRelativePath", { value: `${dir}/${name}` });
  return value;
};

describe("groupNfsFiles", () => {
  it("keeps only the first set's directory when relative paths distinguish two sets", () => {
    const a = [file("hif_000000.nfs", "a"), file("hif_000001.nfs", "a"), file("htk.bin", "a")];
    const b = [file("hif_000000.nfs", "b"), file("htk.bin", "b")];
    expect(groupNfsFiles([...a, ...b])).toEqual(a);
  });

  it("throws a clear error when two sets cannot be told apart", () => {
    const files = [file("hif_000000.nfs"), file("htk.bin"), file("hif_000000.nfs"), file("htk.bin")];
    expect(() => groupNfsFiles(files)).toThrow(/more than one NFS set/i);
  });
});
