import { describe, expect, it } from "vitest";

import {
  baseTitle,
  displayTitle,
  encodeTitleIndex,
  normalizeTitle,
  parseTitleIndex,
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
      "The Legend of Zelda - A Link to the Past",
    );
    expect(baseTitle("Sonic [b1] (Europe)")).toBe("Sonic");
    expect(baseTitle("Plain Title")).toBe("Plain Title");
  });

  it("keeps the whole name when the name opens with a tag", () => {
    expect(baseTitle("(Unknown) Thing")).toBe("(Unknown) Thing");
    expect(baseTitle("[BIOS] Boot ROM")).toBe("[BIOS] Boot ROM");
  });

  it("moves only comma-delimited English articles before the title", () => {
    expect(baseTitle("Legend of Zelda, The (USA)")).toBe("The Legend of Zelda");
    expect(baseTitle("Adventure, An [!]")).toBe("An Adventure");
    expect(baseTitle("Train, A: New World")).toBe("A Train: New World");
    expect(baseTitle("Legend of Zelda, THE")).toBe("The Legend of Zelda");
    expect(baseTitle("The Legend of Zelda")).toBe("The Legend of Zelda");
    expect(baseTitle("Zelda, The Adventure of Link")).toBe("Zelda, The Adventure of Link");
    expect(baseTitle("Game, Another")).toBe("Game, Another");
  });
});

describe("displayTitle", () => {
  it.each([
    ["Abadia del Crimen, La", "La Abadia del Crimen"],
    ["5eme Axe, Le", "Le 5eme Axe"],
    ["4 Fantastiques, Les", "Les 4 Fantastiques"],
    ["Aufstand der Dinge, Der", "Der Aufstand der Dinge"],
    ["3er Reihe, Die", "Die 3er Reihe"],
    ["Aktienspiel, Das", "Das Aktienspiel"],
    ["Arte de la Guerra, El", "El Arte de la Guerra"],
    ["Aguilas, Las", "Las Aguilas"],
    ["Caballeros, Los", "Los Caballeros"],
    ["Cuscino rosa, Il", "Il Cuscino rosa"],
    ["Animali, Gli", "Gli Animali"],
    ["Amsterdamse Effectenbeurs, De", "De Amsterdamse Effectenbeurs"],
    ["Grote Wonder, Het", "Het Grote Wonder"],
    ["Aigle D'Or, L'", "L'Aigle D'Or"],
    ["Aigle, L’", "L'Aigle"],
    ["Legend of Zelda, The (U) [!]", "The Legend of Zelda (U) [!]"],
    ["Ameropa, Das - Juli 1996", "Das Ameropa - Juli 1996"],
    ["Train, A: New World", "A Train: New World"],
  ])("formats %s and preserves the suffix", (source, expected) => {
    expect(displayTitle(source)).toBe(expected);
    expect(displayTitle(displayTitle(source))).toBe(expected);
    expect(baseTitle(source)).toBe(baseTitle(expected));
  });

  it("keeps ordinary commas, subtitle articles, and numeral spellings intact", () => {
    for (const title of [
      "Look This Way, Baby",
      "Game, Another",
      "Game (Name, The)",
      "Series - Story, The",
      "Final Fantasy IV",
      "Final Fantasy 4",
      "Mega Man X",
      "Mega Man 10",
    ]) {
      expect(displayTitle(title)).toBe(title);
    }
  });
});

describe("encodeTitleIndex", () => {
  it("unifies article labels but keeps numeral variants as separate titles", () => {
    const entries = ["Aktienspiel, Das", "Das Aktienspiel", "Final Fantasy IV", "Final Fantasy 4"].map((name) => ({
      name,
      slugs: ["test"],
    }));
    expect(parseTitleIndex(encodeTitleIndex(entries)).titles.map(({ name }) => name)).toEqual([
      "Das Aktienspiel",
      "Final Fantasy 4",
      "Final Fantasy IV",
    ]);
  });
  it("groups leading and trailing articles across packs and release variants", () => {
    const entries = [
      { name: "The Legend of Zelda", slugs: ["nes"] },
      { name: "Legend of Zelda, The", slugs: ["fds"] },
      { name: "Legend of Zelda, The (USA) [!]", slugs: ["nes"] },
      { name: "Legend of Zelda, The - A Link to the Past", slugs: ["snes"] },
      { name: "The Legend of Zelda - A Link to the Past", slugs: ["gba"] },
    ];
    const encoded = encodeTitleIndex(entries);
    const index = parseTitleIndex(encoded);
    expect(index.titles).toEqual([
      { name: "The Legend of Zelda", normalized: "the legend of zelda", packs: [0, 2] },
      {
        name: "The Legend of Zelda - A Link to the Past",
        normalized: "the legend of zelda a link to the past",
        packs: [1, 3],
      },
    ]);
    expect(encodeTitleIndex([...entries].reverse())).toBe(encoded);
    for (const entry of entries) {
      const title = index.titles.find((row) => row.normalized === normalizeTitle(baseTitle(entry.name)));
      expect(title?.packs.map((pack) => index.packs[pack])).toEqual(expect.arrayContaining(entry.slugs));
    }
  });

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
