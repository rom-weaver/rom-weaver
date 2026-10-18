import { describe, expect, it } from "vitest";
import { matchPlaylistLines, realPlaylistLines, renamePlaylistText } from "../../src/lib/playlist-names.ts";

describe("playlist names", () => {
  const staged = ["Pok_mon (Disc 2).iso", "Pok_mon (Disc 1).iso", "Pok_mon (Disc 1).bin"];
  const real = ["Pokémon (Disc 2).iso", "Pokémon (Disc 1).iso", "Pokémon (Disc 1).bin"];

  it("finds the file behind each playlist line by its staged name", () => {
    const lines = ["Pok_mon (Disc 1).iso", "Pok_mon (Disc 2).iso", "gone.iso"];
    expect(matchPlaylistLines(lines, staged)).toEqual([1, 0, -1]);
  });

  it("names each line after the user's file and keeps unmatched lines", () => {
    const lines = ["Pok_mon (Disc 1).iso", "gone.iso"];
    expect(realPlaylistLines(lines, [1, -1], real)).toEqual(["Pokémon (Disc 1).iso", "gone.iso"]);
  });

  it("rewrites playlist text line by line", () => {
    const renames = new Map([["Pok_mon (Disc 1).iso", "Pokémon (Disc 1).iso"]]);
    expect(renamePlaylistText("Pok_mon (Disc 1).iso\nother.iso\n", renames)).toBe("Pokémon (Disc 1).iso\nother.iso\n");
  });
});
