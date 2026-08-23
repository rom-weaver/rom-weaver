import { describe, expect, it } from "vitest";
import {
  formatIdentifyTitle,
  identifyOutputNameSuggestion,
  uniqueIdentifyTitles,
} from "../../src/presentation/identify-title.ts";
import type { ParsedIdentifyResolution } from "../../src/types/identify.ts";

describe("formatIdentifyTitle", () => {
  it("expands GoodTools regions and keeps the source name available as an alias", () => {
    const source = "Pokemon - Emerald Version (UE) [!]";

    expect(formatIdentifyTitle(source)).toBe("Pokemon - Emerald Version (USA, Europe)");
    expect(uniqueIdentifyTitles([source, "Pokemon - Emerald Version (USA, Europe)"])).toEqual([
      "Pokemon - Emerald Version (USA, Europe)",
    ]);
  });

  it("preserves GoodTools tags other than the verified-dump marker", () => {
    expect(formatIdentifyTitle("Game (E) (M3) [b1] [!]")).toBe("Game (Europe) (M3) [b1]");
  });

  it("leaves non-region revision parentheses intact", () => {
    expect(formatIdentifyTitle("Game (U) (Rev 1) [!]")).toBe("Game (USA) (Rev 1)");
  });

  it("expands compact and extended region codes", () => {
    expect(formatIdentifyTitle("Game (JUE) [!]")).toBe("Game (Japan, USA, Europe)");
    expect(formatIdentifyTitle("Game (HK) [!]")).toBe("Game (Hong Kong)");
    expect(formatIdentifyTitle("Game (NL) [!]")).toBe("Game (Netherlands)");
    expect(formatIdentifyTitle("Game (D) [!]")).toBe("Game (Netherlands)");
    expect(formatIdentifyTitle("Game (T) [!]")).toBe("Game (Taiwan)");
    expect(formatIdentifyTitle("Game (1) [!]")).toBe("Game (Japan, Korea)");
    expect(formatIdentifyTitle("Game (4) [!]")).toBe("Game (USA, Brazil)");
  });
});

const resolution = (status: ParsedIdentifyResolution["status"], ...names: string[]): ParsedIdentifyResolution => ({
  matches: names.map((name) => ({
    algorithm: "crc32",
    database: "No-Intro",
    name,
    platform: "Nintendo Game Boy",
    variant: "raw",
  })),
  status,
});

describe("identifyOutputNameSuggestion", () => {
  it("offers the formatted title of a single confident match", () => {
    expect(identifyOutputNameSuggestion(resolution("matched", "Tetris (JUE) [!]"), "tetris_rom")).toBe(
      "Tetris (Japan, USA, Europe)",
    );
  });

  it("removes the characters a filename cannot hold and keeps GoodTools tags", () => {
    expect(identifyOutputNameSuggestion(resolution("matched", "Game: Part 1/2 [T+Eng]"), "rom")).toBe(
      "Game Part 1 2 [T+Eng]",
    );
  });

  it("offers nothing when the field already holds the suggestion", () => {
    expect(identifyOutputNameSuggestion(resolution("matched", "Tetris (U) [!]"), " Tetris (USA) ")).toBeNull();
  });

  it("offers nothing without one confident answer", () => {
    expect(identifyOutputNameSuggestion(resolution("ambiguous", "Tetris (USA)"), "rom")).toBeNull();
    expect(identifyOutputNameSuggestion(resolution("unknown"), "rom")).toBeNull();
    expect(identifyOutputNameSuggestion(resolution("unavailable"), "rom")).toBeNull();
    expect(identifyOutputNameSuggestion(undefined, "rom")).toBeNull();
    expect(identifyOutputNameSuggestion(resolution("matched", "Tetris (USA)", "Alleyway (USA)"), "rom")).toBeNull();
  });
});
