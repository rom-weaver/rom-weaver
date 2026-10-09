import { describe, expect, it } from "vitest";
import { parseWeaveParseResult } from "../../src/lib/runtime/weave-result.ts";

describe("parseWeaveParseResult", () => {
  it("uses strict record and scalar coercion for weave wire values", () => {
    const parsed = parseWeaveParseResult({
      weave: {
        weave: {
          output: { name: "  patched.sfc  " },
          patches: [{ id: "  patch-1  " }],
          rom: { name: "  original.sfc  " },
          version: 1n,
        },
        source_kind: "json",
        warnings: [],
      },
    });

    expect(parsed?.weave).toMatchObject({
      output: { name: "patched.sfc" },
      patches: [{ id: "patch-1" }],
      rom: { name: "original.sfc" },
      version: 1,
    });
  });

  it("retains fixed and producer-member target selectors", () => {
    const parsed = parseWeaveParseResult({
      weave: {
        weave: {
          patches: [
            { input: { member: "disc/track01.bin", rom: true }, target: { member: "disc/track01.bin", rom: true } },
            { target: { member: "generated/track01.bin", patch: "first" } },
          ],
          version: 2,
        },
        source_kind: "json",
        warnings: [],
      },
    });

    expect(parsed?.weave.patches).toEqual([
      { input: { member: "disc/track01.bin", rom: true }, target: { member: "disc/track01.bin", rom: true } },
      { target: { member: "generated/track01.bin", patch: "first" } },
    ]);
  });

  it("rejects arrays where a strict wire record is required", () => {
    expect(parseWeaveParseResult({ weave: { weave: [], source_kind: "json", warnings: [] } })).toBeUndefined();
    expect(
      parseWeaveParseResult({
        weave: {
          weave: { patches: [], rom: [], version: 1 },
          source_kind: "json",
          warnings: [],
        },
      })?.weave.rom,
    ).toBeUndefined();
  });
});

it("accepts an existing bundle event document", () => {
  expect(
    parseWeaveParseResult({ bundle: { bundle: { version: 1, patches: [] }, source_kind: "json", warnings: [] } }),
  ).toMatchObject({ weave: { version: 1, patches: [] } });
});
