import { describe, expect, it } from "vitest";
import {
  formatIdentifyTitle,
  identifiedOutputBaseName,
  uniqueIdentifyDisplayNames,
  uniqueIdentifyTitles,
} from "../../src/presentation/identify-title.ts";
import type { ParsedIdentifyResolution } from "../../src/types/identify.ts";

describe("formatIdentifyTitle", () => {
  it("expands GoodTools regions and keeps the source name available", () => {
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

  it("keeps every source and readable name available for display", () => {
    expect(
      uniqueIdentifyDisplayNames([
        {
          name: "Pokemon - Emerald Version (UE) [!]",
          alternateNames: ["Pokemon - Emerald Version (U) [!]"],
        },
        {
          name: "Pokemon - Emerald Version (USA, Europe)",
          alternateNames: ["Pokemon - Emerald Version (E) [!]"],
        },
      ]),
    ).toEqual([
      "Pokemon - Emerald Version (UE) [!]",
      "Pokemon - Emerald Version (U) [!]",
      "Pokemon - Emerald Version (USA, Europe)",
      "Pokemon - Emerald Version (E) [!]",
    ]);
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

describe("identifiedOutputBaseName", () => {
  it("formats the title of a single confident match", () => {
    expect(identifiedOutputBaseName(resolution("matched", "Tetris (JUE) [!]"))).toBe("Tetris (Japan, USA, Europe)");
  });

  it("removes the characters a filename cannot hold and keeps GoodTools tags", () => {
    expect(identifiedOutputBaseName(resolution("matched", "Game: Part 1/2 [T+Eng]"))).toBe("Game Part 1 2 [T+Eng]");
  });

  it("names nothing without one confident answer", () => {
    expect(identifiedOutputBaseName(resolution("ambiguous", "Tetris (USA)"))).toBeNull();
    expect(identifiedOutputBaseName(resolution("unknown"))).toBeNull();
    expect(identifiedOutputBaseName(resolution("unavailable"))).toBeNull();
    expect(identifiedOutputBaseName(undefined)).toBeNull();
    expect(identifiedOutputBaseName(resolution("matched", "Tetris (USA)", "Alleyway (USA)"))).toBeNull();
  });
});
