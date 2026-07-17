import { describe, expect, it } from "vitest";
import { buildBundleApplySessionPlan, bundleChainEndpointChecks } from "../../src/lib/bundle/bundle-session-model.ts";
import type { ParsedBundleParseResult } from "../../src/types/bundle.ts";

/**
 * `buildBundleApplySessionPlan` is the pure mapping from a parsed rom-weaver-bundle.json to the webapp's
 * acquisition/session plan. These cases lock optional-flag seeding, relative url/path resolution
 * against the bundle's own URL, acquisition of every toggleable entry, effective chain-check
 * resolution against the rom/output endpoints, and the output-defaults mapping onto the output
 * card's name/header controls.
 */

const BUNDLE_URL = "https://hacks.example/releases/rom-weaver-bundle.json";

const parsedResult = (overrides: Partial<ParsedBundleParseResult> = {}): ParsedBundleParseResult => ({
  bundle: { patches: [], version: 1 },
  patchSources: [],
  sourceKind: "json",
  warnings: [],
  ...overrides,
});

describe("buildBundleApplySessionPlan", () => {
  it("maps optional flags, metadata, and header modes onto index-aligned entries", () => {
    const plan = buildBundleApplySessionPlan(
      parsedResult({
        bundle: {
          output: { name: "Rebalance.sfc" },
          patches: [
            { header: "strip", label: "stable", name: "Core" },
            { description: "Extra maps" },
            { optional: true },
          ],
          version: 1,
        },
        patchSources: [
          { source: { kind: "url", url: "https://cdn.example/core.ips" } },
          { source: { kind: "url", url: "maps.bps" } },
          { source: { kind: "url", url: "../optional/music.ups" } },
        ],
        warnings: ["ignored member: readme.txt"],
      }),
      BUNDLE_URL,
    );
    expect(plan.key).toBe(BUNDLE_URL);
    expect(plan.name).toBe("Rebalance.sfc");
    expect(plan.warnings).toEqual(["ignored member: readme.txt"]);
    expect(plan.entries).toEqual([
      {
        acquisition: { kind: "url", url: "https://cdn.example/core.ips" },
        header: "strip",
        label: "stable",
        name: "Core",
        optional: false,
      },
      {
        acquisition: { kind: "url", url: "https://hacks.example/releases/maps.bps" },
        description: "Extra maps",
        optional: false,
      },
      {
        acquisition: { kind: "url", url: "https://hacks.example/optional/music.ups" },
        optional: true,
      },
    ]);
  });

  it("resolves relative plain-bundle `path` entries as siblings of the rom-weaver-bundle.json", () => {
    const plan = buildBundleApplySessionPlan(
      parsedResult({
        bundle: {
          patches: [{}],
          rom: { path: "roms/game.bin" },
          version: 1,
        },
        patchSources: [{ source: { kind: "path", path: "change.ips" } }],
        romSource: { kind: "path", path: "roms/game.bin" },
      }),
      BUNDLE_URL,
    );
    expect(plan.romAcquisition).toEqual({ kind: "url", url: "https://hacks.example/releases/roms/game.bin" });
    expect(plan.entries[0]?.acquisition).toEqual({
      kind: "url",
      url: "https://hacks.example/releases/change.ips",
    });
  });

  it("passes extracted archive leaves through untouched", () => {
    const plan = buildBundleApplySessionPlan(
      parsedResult({
        bundle: { patches: [{}], version: 1 },
        patchSources: [{ source: { extractedPath: "/work/change.ips", kind: "extracted" } }],
        romSource: { extractedPath: "/work/game.bin", kind: "extracted" },
        sourceKind: "archive",
      }),
      BUNDLE_URL,
    );
    expect(plan.romAcquisition).toEqual({ extractedPath: "/work/game.bin", kind: "extracted" });
    expect(plan.entries[0]?.acquisition).toEqual({ extractedPath: "/work/change.ips", kind: "extracted" });
  });

  it("acquires entries regardless of their optional toggle", () => {
    const plan = buildBundleApplySessionPlan(
      parsedResult({
        bundle: {
          patches: [{ name: "On" }, { name: "Off", optional: true }],
          version: 1,
        },
        patchSources: [{ source: { kind: "url", url: "kept.ips" } }, { source: { kind: "url", url: "retired.ips" } }],
      }),
      BUNDLE_URL,
    );
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries.map((entry) => [entry.name, entry.optional])).toEqual([
      ["On", false],
      ["Off", true],
    ]);
  });

  it("resolves chain-endpoint checks from the rom/output while entries keep only their own checks", () => {
    const romChecks = { checksums: { crc32: "aaaaaaaa" }, size: 42 };
    const midChecks = { checksums: { crc32: "bbbbbbbb" } };
    const finalChecks = { checksums: { crc32: "cccccccc" } };
    const bundle = {
      output: { checks: finalChecks },
      patches: [
        // First patch relies on rom.checks; its output is a declared mid-chain state.
        { outputChecks: midChecks },
        // Last patch declares its input and relies on output.checks for its result.
        { inputChecks: midChecks },
      ],
      rom: { checks: romChecks },
      version: 1,
    };
    // Endpoint verification is session-level: rom.checks verify the ROM, output.checks the result.
    expect(bundleChainEndpointChecks(bundle)).toEqual({ input: romChecks, output: finalChecks });
    // A patch's own declared checks win over the endpoint fallbacks.
    expect(
      bundleChainEndpointChecks({
        output: { checks: finalChecks },
        patches: [{ inputChecks: midChecks, outputChecks: midChecks }],
        rom: { checks: romChecks },
        version: 1,
      }),
    ).toEqual({ input: midChecks, output: midChecks });
    // Plan entries are never decorated with inherited rom/output checks - a patch
    // that declared none shows none.
    const plan = buildBundleApplySessionPlan(
      parsedResult({
        bundle,
        patchSources: [{ source: { kind: "url", url: "a.ips" } }, { source: { kind: "url", url: "b.ips" } }],
      }),
      BUNDLE_URL,
    );
    expect(plan.chainEndpointChecks).toEqual({ input: romChecks, output: finalChecks });
    expect(plan.entries.map((entry) => [entry.inputChecks, entry.outputChecks])).toEqual([
      [undefined, midChecks],
      [midChecks, undefined],
    ]);
  });

  it("surfaces the expected ROM when the bundle ships none", () => {
    const plan = buildBundleApplySessionPlan(
      parsedResult({
        bundle: {
          patches: [{}],
          rom: { checks: { checksums: { crc32: "aaaaaaaa" }, size: 42 }, name: "Game (USA).nes" },
          version: 1,
        },
        patchSources: [{ source: { kind: "url", url: "change.ips" } }],
      }),
      BUNDLE_URL,
    );
    expect(plan.romAcquisition).toBeUndefined();
    expect(plan.romExpectation).toEqual({
      checks: { checksums: { crc32: "aaaaaaaa" }, size: 42 },
      name: "Game (USA).nes",
    });
  });

  it("maps output name and header defaults", () => {
    const withOutput = (output: NonNullable<ParsedBundleParseResult["bundle"]["output"]>) =>
      buildBundleApplySessionPlan(parsedResult({ bundle: { output, patches: [], version: 1 } }), BUNDLE_URL)
        .outputDefaults;
    expect(withOutput({ header: "keep", name: "hack v2" })).toEqual({
      header: "keep",
      name: "hack v2",
    });
    expect(withOutput({})).toEqual({});
  });

  it("throws on an unresolvable relative source", () => {
    expect(() =>
      buildBundleApplySessionPlan(
        parsedResult({
          bundle: { patches: [{}], version: 1 },
          patchSources: [{ source: { kind: "url", url: "change.ips" } }],
        }),
        "not a url",
      ),
    ).toThrow(/not resolvable/);
  });
});
