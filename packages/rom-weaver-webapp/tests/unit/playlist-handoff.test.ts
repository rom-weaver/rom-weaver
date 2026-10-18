import { describe, expect, it, vi } from "vitest";
import {
  hasSeveralDiscs,
  isPlaylistFile,
  isSamePlaylistFile,
  type PlaylistDisc,
  setPlaylistHandoff,
  subscribePlaylistHandoff,
  takePlaylistHandoff,
} from "../../src/lib/playlist-handoff.ts";

const disc = (name: string): PlaylistDisc => ({ name, size: 1, source: new File(["x"], name) });

describe("playlist handoff", () => {
  it("hands the files over once and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlaylistHandoff(listener);
    setPlaylistHandoff([disc("a.cue"), disc("b.cue")]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takePlaylistHandoff().map((entry) => entry.name)).toEqual(["a.cue", "b.cue"]);
    expect(takePlaylistHandoff()).toEqual([]);
    unsubscribe();
    setPlaylistHandoff([disc("c.cue")]);
    expect(listener).toHaveBeenCalledTimes(1);
    takePlaylistHandoff();
  });

  it("offers a playlist only for several discs, not for their track files", () => {
    expect(hasSeveralDiscs(["Game.disc01.cue", "Game.disc01.bin", "Game.disc02.cue", "Game.disc02.bin"])).toBe(true);
    expect(hasSeveralDiscs(["Game.cue", "Game.bin"])).toBe(false);
    expect(hasSeveralDiscs(["readme.txt"])).toBe(false);
    expect(hasSeveralDiscs(["a.CHD", "b.chd"])).toBe(true);
  });

  it("lists only disc and track files, not readmes or covers", () => {
    for (const name of ["a.cue", "a.BIN", "a.ccd", "a.img", "a.sub", "a.mdf", "a.chd"]) {
      expect(isPlaylistFile(name)).toBe(true);
    }
    for (const name of ["readme.txt", "cover.png", "notes"]) expect(isPlaylistFile(name)).toBe(false);
  });

  it("tells the same file from a different one with the same name", () => {
    const a = new File(["x"], "a.bin", { lastModified: 1 });
    expect(
      isSamePlaylistFile(
        { name: "a.bin", size: 1, source: a },
        { name: "a.bin", size: 1, source: new File(["x"], "a.bin", { lastModified: 2 }) },
      ),
    ).toBe(false);
    expect(isSamePlaylistFile({ name: "a.bin", size: 1, source: a }, { name: "a.bin", size: 1, source: a })).toBe(true);
    expect(
      isSamePlaylistFile(
        { name: "a.bin", size: 1, source: a },
        { name: "a.bin", size: 1, source: new File(["x"], "a.bin", { lastModified: 1 }) },
      ),
    ).toBe(true);
  });
});
