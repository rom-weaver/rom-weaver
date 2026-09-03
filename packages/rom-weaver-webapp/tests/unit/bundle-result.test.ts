import { describe, expect, it } from "vitest";
import { parseBundleParseResult } from "../../src/lib/runtime/bundle-result.ts";

describe("parseBundleParseResult", () => {
  it("uses strict record and scalar coercion for bundle wire values", () => {
    const parsed = parseBundleParseResult({
      bundle: {
        bundle: {
          output: { name: "  patched.sfc  " },
          patches: [{ id: "  patch-1  " }],
          rom: { name: "  original.sfc  " },
          version: 1n,
        },
        source_kind: "json",
        warnings: [],
      },
    });

    expect(parsed?.bundle).toMatchObject({
      output: { name: "patched.sfc" },
      patches: [{ id: "patch-1" }],
      rom: { name: "original.sfc" },
      version: 1,
    });
  });

  it("rejects arrays where a strict wire record is required", () => {
    expect(parseBundleParseResult({ bundle: { bundle: [], source_kind: "json", warnings: [] } })).toBeUndefined();
    expect(
      parseBundleParseResult({
        bundle: {
          bundle: { patches: [], rom: [], version: 1 },
          source_kind: "json",
          warnings: [],
        },
      })?.bundle.rom,
    ).toBeUndefined();
  });
});
