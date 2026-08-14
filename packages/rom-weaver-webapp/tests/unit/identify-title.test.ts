import { describe, expect, it } from "vitest";
import { formatIdentifyTitle, uniqueIdentifyTitles } from "../../src/presentation/identify-title.ts";

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
