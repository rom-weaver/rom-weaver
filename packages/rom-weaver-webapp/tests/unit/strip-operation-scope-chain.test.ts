import { describe, expect, it } from "vitest";
import { stripOperationScopeChain } from "../../src/lib/runtime/run-output-paths.ts";

const identity = (segment: string) => segment;

describe("stripOperationScopeChain", () => {
  it("drops a leading operations/<uuid> scratch pair", () => {
    const uuid = "668e5c59-de19-4d57-8967-3a950ca985b9";
    expect(stripOperationScopeChain(["operations", uuid, "patch.ips"], identity)).toEqual(["patch.ips"]);
  });

  it("drops the pair after a real archive segment", () => {
    const uuid = "002f7230-ed1e-4e68-8ed6-8bed206c88ba";
    expect(stripOperationScopeChain(["set.zip", "operations", uuid, "nested", "patch.ips"], identity)).toEqual([
      "set.zip",
      "nested",
      "patch.ips",
    ]);
  });

  it("accepts the 32-hex fallback id shape", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(stripOperationScopeChain(["operations", id, "rom.bin"], identity)).toEqual(["rom.bin"]);
  });

  it("keeps an operations segment that is not followed by an id", () => {
    expect(stripOperationScopeChain(["operations", "readme.txt"], identity)).toEqual(["operations", "readme.txt"]);
  });

  it("keeps a real folder literally named operations", () => {
    expect(stripOperationScopeChain(["archive.zip", "operations", "manual"], identity)).toEqual([
      "archive.zip",
      "operations",
      "manual",
    ]);
  });

  it("reads the segment through the accessor for object entries", () => {
    const uuid = "668e5c59-de19-4d57-8967-3a950ca985b9";
    const entries = [{ fileName: "operations" }, { fileName: uuid }, { fileName: "patch.ips" }];
    expect(stripOperationScopeChain(entries, (entry) => entry.fileName)).toEqual([{ fileName: "patch.ips" }]);
  });
});
