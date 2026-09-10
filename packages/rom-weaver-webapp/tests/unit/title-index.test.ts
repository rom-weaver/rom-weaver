import { describe, expect, it } from "vitest";

import {
  baseTitle,
  encodeTitleIndex,
  normalizeTitle,
  parseTitleIndex,
  searchTitleIndex,
  TITLE_INDEX_FORMAT,
} from "../../src/lib/identify/title-index.mjs";

describe("normalizeTitle", () => {
  it("lowercases, folds diacritics, and collapses non-alphanumeric runs", () => {
    expect(normalizeTitle("Astérix & Obélix -- XXL")).toBe("asterix obelix xxl");
    expect(normalizeTitle("  Pokémon: Blue_Version! ")).toBe("pokemon blue version");
    expect(normalizeTitle("Ærø Ærø")).toBe("aero aero");
    expect(normalizeTitle("---")).toBe("");
    expect(normalizeTitle("")).toBe("");
  });

  it("keeps characters that have no ASCII base", () => {
    expect(normalizeTitle("ドラゴン Quest")).toBe("ドラゴン quest");
  });
});

describe("baseTitle", () => {
  it("drops the first tag group and everything after it", () => {
    expect(baseTitle("Legend of Zelda, The - A Link to the Past (USA) [!]")).toBe(
      "Legend of Zelda, The - A Link to the Past",
    );
    expect(baseTitle("Sonic [b1] (Europe)")).toBe("Sonic");
    expect(baseTitle("Plain Title")).toBe("Plain Title");
  });

  it("keeps the whole name when the name opens with a tag", () => {
    expect(baseTitle("(Unknown) Thing")).toBe("(Unknown) Thing");
    expect(baseTitle("[BIOS] Boot ROM")).toBe("[BIOS] Boot ROM");
  });
});

describe("encodeTitleIndex", () => {
  it("merges packs per normalized title and is deterministic", () => {
    const json = encodeTitleIndex([
      { name: "Sonic the Hedgehog", slugs: ["sega-32x"] },
      { name: "sonic the hedgehog", slugs: ["sega-mega-drive-genesis"] },
      { name: "Metroid", slugs: ["nintendo-game-boy-advance"] },
    ]);
    expect(JSON.parse(json)).toEqual({
      format: TITLE_INDEX_FORMAT,
      packs: ["nintendo-game-boy-advance", "sega-32x", "sega-mega-drive-genesis"],
      titles: [
        ["Metroid", [0]],
        // Two spellings fold to one key; the first by plain string sort wins.
        ["Sonic the Hedgehog", [1, 2]],
      ],
    });
    expect(
      encodeTitleIndex([
        { name: "Metroid", slugs: ["nintendo-game-boy-advance"] },
        { name: "sonic the hedgehog", slugs: ["sega-mega-drive-genesis"] },
        { name: "Sonic the Hedgehog", slugs: ["sega-32x"] },
      ]),
    ).toBe(json);
  });

  it("skips names with no normalized form and rejects an empty slug", () => {
    expect(JSON.parse(encodeTitleIndex([{ name: "---", slugs: ["a"] }])).titles).toEqual([]);
    expect(() => encodeTitleIndex([{ name: "Game", slugs: [""] }])).toThrow(/empty pack slug/u);
  });
});

describe("parseTitleIndex", () => {
  const valid = encodeTitleIndex([{ name: "Metroid", slugs: ["gba"] }]);

  it("round trips an encoded index", () => {
    expect(parseTitleIndex(valid)).toEqual({
      packs: ["gba"],
      titles: [{ name: "Metroid", normalized: "metroid", packs: [0] }],
    });
  });

  it.each([
    ["{not json", /not JSON/u],
    ['{"format":"other","packs":[],"titles":[]}', /unexpected format/u],
    [`{"format":"${TITLE_INDEX_FORMAT}","packs":{},"titles":[]}`, /packs is not an array/u],
    [`{"format":"${TITLE_INDEX_FORMAT}","packs":[""],"titles":[]}`, /pack slug is empty/u],
    [`{"format":"${TITLE_INDEX_FORMAT}","packs":["a"],"titles":{}}`, /titles is not an array/u],
    [`{"format":"${TITLE_INDEX_FORMAT}","packs":["a"],"titles":[["x"]]}`, /not a \[name, packs\] pair/u],
    [`{"format":"${TITLE_INDEX_FORMAT}","packs":["a"],"titles":[["",[0]]]}`, /title name is empty/u],
    [`{"format":"${TITLE_INDEX_FORMAT}","packs":["a"],"titles":[["x",[]]]}`, /no pack indexes/u],
    [`{"format":"${TITLE_INDEX_FORMAT}","packs":["a"],"titles":[["x",[1]]]}`, /out of range/u],
    ["[]", /not an object/u],
  ])("rejects %s", (text, message) => {
    expect(() => parseTitleIndex(text)).toThrow(message);
  });
});

describe("searchTitleIndex", () => {
  const index = parseTitleIndex(
    encodeTitleIndex([
      { name: "Sonic", slugs: ["gen"] },
      { name: "Sonic the Hedgehog", slugs: ["gen"] },
      { name: "Sonic the Hedgehog 2", slugs: ["gen", "gg"] },
      { name: "Dr. Robotnik's Mean Bean Machine", slugs: ["gen"] },
      { name: "Super Sonic Racer", slugs: ["snes"] },
    ]),
  );

  it("ranks exact, then prefix, then earlier first-token position", () => {
    expect(searchTitleIndex(index, "sonic").map(({ name }) => name)).toEqual([
      "Sonic",
      "Sonic the Hedgehog",
      "Sonic the Hedgehog 2",
      "Super Sonic Racer",
    ]);
    expect(searchTitleIndex(index, "sonic hedgehog").map(({ name }) => name)).toEqual([
      "Sonic the Hedgehog",
      "Sonic the Hedgehog 2",
    ]);
  });

  it("requires every token to be a substring and returns the pack slugs", () => {
    expect(searchTitleIndex(index, "robotnik bean")).toEqual([
      { name: "Dr. Robotnik's Mean Bean Machine", slugs: ["gen"] },
    ]);
    expect(searchTitleIndex(index, "sonic mario")).toEqual([]);
    expect(searchTitleIndex(index, "hedgehog 2")[0]?.slugs).toEqual(["gen", "gg"]);
  });

  it("returns nothing for an empty query and honours the limit", () => {
    expect(searchTitleIndex(index, "")).toEqual([]);
    expect(searchTitleIndex(index, "  -- ")).toEqual([]);
    expect(searchTitleIndex(index, "sonic", { limit: 2 })).toHaveLength(2);
    expect(searchTitleIndex(index, "sonic", { limit: 0 })).toEqual([]);
  });
});
