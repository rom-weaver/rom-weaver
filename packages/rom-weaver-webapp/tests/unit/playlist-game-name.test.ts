import { describe, expect, it } from "vitest";
import { checkGameName } from "../../src/storage/browser/playlist-game-name.ts";

describe("checkGameName", () => {
  it("accepts a name whose longest file name is 255 bytes", () => {
    expect(checkGameName("a".repeat(241))).toBe("");
    expect(checkGameName("a".repeat(242))).toMatch(/too long/);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(checkGameName("中".repeat(80))).toBe("");
    expect(checkGameName("中".repeat(81))).toMatch(/too long/);
    expect(checkGameName("中".repeat(100))).toMatch(/too long/);
  });

  it("refuses reserved characters, Windows device names, and a trailing dot or space", () => {
    expect(checkGameName("A/B")).toMatch(/cannot contain/);
    expect(checkGameName("CON")).toMatch(/Windows reserves/);
    expect(checkGameName("Game.")).toMatch(/end with/);
    expect(checkGameName("  ")).toBe("");
  });
});
