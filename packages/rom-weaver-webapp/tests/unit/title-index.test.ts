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

  it("requires every token to match and returns the pack slugs", () => {
    expect(searchTitleIndex(index, "robotnik bean")).toEqual([
      { name: "Dr. Robotnik's Mean Bean Machine", slugs: ["gen"] },
    ]);
    expect(searchTitleIndex(index, "sonic mario")).toEqual([]);
    expect(searchTitleIndex(index, "hedgehog 2")[0]?.slugs).toEqual(["gen", "gg"]);
  });

  it("finds every Zelda title regardless of the word's position", () => {
    const zelda = parseTitleIndex(
      encodeTitleIndex([
        { name: "The Legend of Zelda", slugs: ["nes"] },
        { name: "Zelda II - The Adventure of Link", slugs: ["nes"] },
        { name: "The Legend of Zelda - A Link to the Past", slugs: ["snes"] },
        { name: "Super Mario Bros.", slugs: ["nes"] },
      ]),
    );
    expect(searchTitleIndex(zelda, "zelda").map(({ name }) => name)).toEqual([
      "Zelda II - The Adventure of Link",
      "The Legend of Zelda",
      "The Legend of Zelda - A Link to the Past",
    ]);
  });

  it.each(["snic", "soonic", "sonik", "snoic"])("corrects the typo %s", (query) => {
    expect(searchTitleIndex(index, query)[0]).toEqual({ name: "Sonic", slugs: ["gen"] });
  });

  it("matches reordered words with typos and preserves platform results", () => {
    expect(searchTitleIndex(index, "hedghog snoic 2")).toEqual([
      { name: "Sonic the Hedgehog 2", slugs: ["gen", "gg"] },
    ]);
    expect(searchTitleIndex(index, "snoic mario")).toEqual([]);
  });

  it("ranks literal matches ahead of corrections before applying the limit", () => {
    const ranked = parseTitleIndex(
      encodeTitleIndex([
        { name: "Sonic", slugs: ["gen"] },
        { name: "Sonic Adventure", slugs: ["dc"] },
        { name: "Sonik", slugs: ["other"] },
      ]),
    );
    expect(searchTitleIndex(ranked, "sonik").map(({ name }) => name)).toEqual(["Sonik", "Sonic", "Sonic Adventure"]);
    expect(searchTitleIndex(ranked, "sonik", { limit: 1 })[0]?.name).toBe("Sonik");
  });

  it("keeps short tokens and numbers literal and rejects larger spelling errors", () => {
    expect(searchTitleIndex(index, "snc")).toEqual([]);
    expect(searchTitleIndex(index, "sonic 3")).toEqual([]);
    expect(searchTitleIndex(index, "sxnyc")).toEqual([]);
  });

  it("ranks an earlier corrected word ahead of a shorter title", () => {
    const ranked = parseTitleIndex(
      encodeTitleIndex([
        { name: "Zzzz Sonic", slugs: ["gen"] },
        { name: "Sonic Universe", slugs: ["gen"] },
      ]),
    );
    expect(searchTitleIndex(ranked, "snoic", { limit: 1 })[0]?.name).toBe("Sonic Universe");
  });

  it("returns nothing for an empty query and honours the limit", () => {
    expect(searchTitleIndex(index, "")).toEqual([]);
    expect(searchTitleIndex(index, "  -- ")).toEqual([]);
    expect(searchTitleIndex(index, "sonic", { limit: 2 })).toHaveLength(2);
    expect(searchTitleIndex(index, "sonic", { limit: 0 })).toEqual([]);
  });
});
