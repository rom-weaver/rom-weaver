import { describe, expect, it } from "vitest";
import { checkGameName } from "../../src/storage/browser/playlist-game-name.ts";

// The longest file a rename makes is `<game> (Disc 99) (Track 99).bin`.
const LONGEST_GAME_NAME_BYTES = 255 - " (Disc 99) (Track 99).bin".length;

describe("checkGameName", () => {
  it("allows a name whose longest renamed file name is 255 bytes", () => {
    expect(checkGameName("a".repeat(LONGEST_GAME_NAME_BYTES))).toBe("");
    expect(checkGameName("a".repeat(LONGEST_GAME_NAME_BYTES + 1))).toMatch(/too long/);
  });

  it("counts UTF-8 bytes, not characters", () => {
    const characters = Math.floor(LONGEST_GAME_NAME_BYTES / 3);
    expect(checkGameName("\u4e2d".repeat(characters))).toBe("");
    expect(checkGameName("\u4e2d".repeat(characters + 1))).toMatch(/too long/);
    expect(checkGameName("\u4e2d".repeat(100))).toMatch(/too long/);
  });

  it("refuses reserved characters, Windows device names, and a trailing dot", () => {
    expect(checkGameName("A/B")).toMatch(/cannot contain/);
    expect(checkGameName("CON")).toMatch(/Windows reserves/);
    expect(checkGameName("Game.")).toMatch(/end with a dot/);
    expect(checkGameName("  ")).toBe("");
  });

  it("accepts a trailing space, which the name loses when trimmed", () => {
    expect(checkGameName("Final ")).toBe("");
  });
});
