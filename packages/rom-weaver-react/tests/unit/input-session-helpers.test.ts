import { describe, expect, it } from "vitest";
import {
  getBinarySourceFileName,
  getBinarySourceListStableIds,
  sameBinarySourceLists,
} from "../../src/public/react/input-session-helpers.ts";
import type { BinarySource } from "../../src/public/react/patcher-form.ts";

const source = (name: string, size = 16): BinarySource => ({ name, size }) as unknown as BinarySource;

describe("getBinarySourceFileName", () => {
  it("reads the name and falls back when absent", () => {
    expect(getBinarySourceFileName(source("rom.bin"), "fallback")).toBe("rom.bin");
    expect(getBinarySourceFileName({} as BinarySource, "fallback")).toBe("fallback");
  });
});

describe("getBinarySourceListStableIds", () => {
  it("disambiguates identical sources by occurrence index", () => {
    const ids = getBinarySourceListStableIds([source("a.bin"), source("a.bin"), source("b.bin")]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]?.endsWith("#1")).toBe(true);
    expect(ids[1]?.endsWith("#2")).toBe(true);
  });
});

describe("sameBinarySourceLists", () => {
  it("compares by stable signature and order", () => {
    expect(sameBinarySourceLists([source("a.bin")], [source("a.bin")])).toBe(true);
    expect(sameBinarySourceLists([source("a.bin")], [source("a.bin", 32)])).toBe(false);
    expect(sameBinarySourceLists([source("a.bin"), source("b.bin")], [source("b.bin"), source("a.bin")])).toBe(false);
    expect(sameBinarySourceLists([source("a.bin")], [source("a.bin"), source("b.bin")])).toBe(false);
  });
});
