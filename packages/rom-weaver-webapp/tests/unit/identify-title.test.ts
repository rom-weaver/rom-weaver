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

  it("removes GoodTools language and dump-status suffixes", () => {
    expect(formatIdentifyTitle("Game (E) (M3) [b1]")).toBe("Game (Europe)");
  });

  it("leaves non-region revision parentheses intact", () => {
    expect(formatIdentifyTitle("Game (U) (Rev 1) [!]")).toBe("Game (USA) (Rev 1)");
  });
});
