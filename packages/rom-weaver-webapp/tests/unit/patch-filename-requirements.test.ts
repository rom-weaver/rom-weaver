import { describe, expect, it } from "vitest";
import { parseFilenameCrc32 } from "../../src/lib/apply/patch-filename-requirements.ts";

// Mirrors the crc32 cases of crates/rom-weaver-cli/src/patch_filename_checksum.rs.
describe("parseFilenameCrc32", () => {
  it.each([
    ["MyHack [crc32:1a2b3c4d].ips", "1a2b3c4d"],
    ["hack (crc32=AABBCCDD).bps", "aabbccdd"],
    ["Game [1a2b3c4d].ips", "1a2b3c4d"],
    ["Game {1A2B3C4D}.ips", "1a2b3c4d"],
    ["hack [crc32:11111111] crc32:11111111.ips", "11111111"],
  ])("reads %s", (name, expected) => {
    expect(parseFilenameCrc32(name)).toBe(expected);
  });

  it.each([
    "MyHack 20231015.ips",
    "hack [crc32:1a2b3c].ips",
    "hack [crc32:1a2b3c4d5].ips",
    "notcrc32:1a2b3c4d.ips",
    "hack [crc32:11111111][crc32:22222222].ips",
    "hack [crc32_1a2b3c4d].ips",
    "",
  ])("ignores %j", (name) => {
    expect(parseFilenameCrc32(name)).toBeUndefined();
  });

  it("ignores a missing name", () => {
    expect(parseFilenameCrc32(undefined)).toBeUndefined();
  });
});
