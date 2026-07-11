import { describe, expect, it } from "vitest";
import {
  buildManifestApplySessionPlan,
  manifestChainEndpointChecks,
} from "../../src/lib/manifest/manifest-session-model.ts";
import type { ParsedManifestParseResult } from "../../src/types/manifest.ts";

/**
 * `buildManifestApplySessionPlan` is the pure mapping from a parsed rw.json to the webapp's
 * acquisition/session plan. These cases lock optional-flag seeding, relative url/path resolution
 * against the manifest's own URL, acquisition of every toggleable entry, effective chain-check
 * resolution against the rom/output endpoints, and the output-defaults mapping onto the output
 * card's name/header controls.
 */

const MANIFEST_URL = "https://hacks.example/releases/rw.json";

const parsedResult = (overrides: Partial<ParsedManifestParseResult> = {}): ParsedManifestParseResult => ({
  manifest: { patches: [], version: 1 },
  patchSources: [],
  sourceKind: "json",
  warnings: [],
  ...overrides,
});

describe("buildManifestApplySessionPlan", () => {
  it("maps optional flags, metadata, and header modes onto index-aligned entries", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: {
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
      MANIFEST_URL,
    );
    expect(plan.key).toBe(MANIFEST_URL);
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

  it("resolves relative plain-manifest `path` entries as siblings of the rw.json", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: {
          patches: [{}],
          rom: { path: "roms/game.bin" },
          version: 1,
        },
        patchSources: [{ source: { kind: "path", path: "change.ips" } }],
        romSource: { kind: "path", path: "roms/game.bin" },
      }),
      MANIFEST_URL,
    );
    expect(plan.romAcquisition).toEqual({ kind: "url", url: "https://hacks.example/releases/roms/game.bin" });
    expect(plan.entries[0]?.acquisition).toEqual({
      kind: "url",
      url: "https://hacks.example/releases/change.ips",
    });
  });

  it("passes extracted archive leaves through untouched", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: { patches: [{}], version: 1 },
        patchSources: [{ source: { extractedPath: "/work/change.ips", kind: "extracted" } }],
        romSource: { extractedPath: "/work/game.bin", kind: "extracted" },
        sourceKind: "archive",
      }),
      MANIFEST_URL,
    );
    expect(plan.romAcquisition).toEqual({ extractedPath: "/work/game.bin", kind: "extracted" });
    expect(plan.entries[0]?.acquisition).toEqual({ extractedPath: "/work/change.ips", kind: "extracted" });
  });

  it("acquires entries regardless of their optional toggle", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: {
          patches: [{ name: "On" }, { name: "Off", optional: true }],
          version: 1,
        },
        patchSources: [{ source: { kind: "url", url: "kept.ips" } }, { source: { kind: "url", url: "retired.ips" } }],
      }),
      MANIFEST_URL,
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
    const manifest = {
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
    expect(manifestChainEndpointChecks(manifest)).toEqual({ input: romChecks, output: finalChecks });
    // A patch's own declared checks win over the endpoint fallbacks.
    expect(
      manifestChainEndpointChecks({
        output: { checks: finalChecks },
        patches: [{ inputChecks: midChecks, outputChecks: midChecks }],
        rom: { checks: romChecks },
        version: 1,
      }),
    ).toEqual({ input: midChecks, output: midChecks });
    // Plan entries are never decorated with inherited rom/output checks - a patch
    // that declared none shows none.
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest,
        patchSources: [{ source: { kind: "url", url: "a.ips" } }, { source: { kind: "url", url: "b.ips" } }],
      }),
      MANIFEST_URL,
    );
    expect(plan.chainEndpointChecks).toEqual({ input: romChecks, output: finalChecks });
    expect(plan.entries.map((entry) => [entry.inputChecks, entry.outputChecks])).toEqual([
      [undefined, midChecks],
      [midChecks, undefined],
    ]);
  });

  it("surfaces the expected ROM when the manifest ships none", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: {
          patches: [{}],
          rom: { checks: { checksums: { crc32: "aaaaaaaa" }, size: 42 }, name: "Game (USA).nes" },
          version: 1,
        },
        patchSources: [{ source: { kind: "url", url: "change.ips" } }],
      }),
      MANIFEST_URL,
    );
    expect(plan.romAcquisition).toBeUndefined();
    expect(plan.romExpectation).toEqual({
      checks: { checksums: { crc32: "aaaaaaaa" }, size: 42 },
      name: "Game (USA).nes",
    });
  });

  it("maps output name and header defaults", () => {
    const withOutput = (output: NonNullable<ParsedManifestParseResult["manifest"]["output"]>) =>
      buildManifestApplySessionPlan(parsedResult({ manifest: { output, patches: [], version: 1 } }), MANIFEST_URL)
        .outputDefaults;
    expect(withOutput({ header: "keep", name: "hack v2" })).toEqual({
      header: "keep",
      name: "hack v2",
    });
    expect(withOutput({})).toEqual({});
  });

  it("throws on an unresolvable relative source", () => {
    expect(() =>
      buildManifestApplySessionPlan(
        parsedResult({
          manifest: { patches: [{}], version: 1 },
          patchSources: [{ source: { kind: "url", url: "change.ips" } }],
        }),
        "not a url",
      ),
    ).toThrow(/not resolvable/);
  });
});
