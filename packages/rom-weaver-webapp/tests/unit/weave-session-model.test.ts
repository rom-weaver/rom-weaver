import { describe, expect, it } from "vitest";
import { buildWeaveApplySessionPlan, weaveChainEndpointChecks } from "../../src/lib/weave/weave-session-model.ts";
import type { ParsedWeaveParseResult } from "../../src/types/weave.ts";

/**
 * `buildWeaveApplySessionPlan` is the pure mapping from a parsed rom-weaver-weave.json to the webapp's
 * acquisition/session plan. These cases lock optional-flag seeding, relative url/path resolution
 * against the weave's own URL, acquisition of every toggleable entry, effective chain-check
 * resolution against the rom/output endpoints, and the output-defaults mapping onto the output
 * card's name/header controls.
 */

const WEAVE_URL = "https://hacks.example/releases/rom-weaver-weave.json";

const parsedResult = (overrides: Partial<ParsedWeaveParseResult> = {}): ParsedWeaveParseResult => ({
  weave: { patches: [], version: 1 },
  patchSources: [],
  sourceKind: "json",
  warnings: [],
  ...overrides,
});

describe("buildWeaveApplySessionPlan", () => {
  it("uses automatic inference for v1 and reads the v2 shared basis", () => {
    const v1 = buildWeaveApplySessionPlan(
      parsedResult({
        weave: { patches: [{}], version: 1 },
        patchSources: [{ source: { kind: "path", path: "one.ips" } }],
      }),
      WEAVE_URL,
    );
    const v2 = buildWeaveApplySessionPlan(
      parsedResult({
        weave: { patchBasis: "previous", patches: [{}], version: 2 },
        patchSources: [{ source: { kind: "path", path: "one.ips" } }],
      }),
      WEAVE_URL,
    );
    expect(v1.patchBasis).toBe("auto");
    expect(v2.patchBasis).toBe("previous");
  });

  it("maps optional flags, metadata, and header modes onto index-aligned entries", () => {
    const plan = buildWeaveApplySessionPlan(
      parsedResult({
        weave: {
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
      WEAVE_URL,
    );
    expect(plan.key).toBe(WEAVE_URL);
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

  it("resolves relative plain-weave `path` entries as siblings of the rom-weaver-weave.json", () => {
    const plan = buildWeaveApplySessionPlan(
      parsedResult({
        weave: {
          patches: [{}],
          rom: { path: "roms/game.bin" },
          version: 1,
        },
        patchSources: [{ source: { kind: "path", path: "change.ips" } }],
        romSource: { kind: "path", path: "roms/game.bin" },
      }),
      WEAVE_URL,
    );
    expect(plan.romAcquisition).toEqual({ kind: "url", url: "https://hacks.example/releases/roms/game.bin" });
    expect(plan.entries[0]?.acquisition).toEqual({
      kind: "url",
      url: "https://hacks.example/releases/change.ips",
    });
  });

  it("passes extracted archive leaves through untouched", () => {
    const plan = buildWeaveApplySessionPlan(
      parsedResult({
        weave: { patches: [{}], version: 1 },
        patchSources: [{ source: { extractedPath: "/work/change.ips", kind: "extracted" } }],
        romSource: { extractedPath: "/work/game.bin", kind: "extracted" },
        sourceKind: "archive",
      }),
      WEAVE_URL,
    );
    expect(plan.romAcquisition).toEqual({ extractedPath: "/work/game.bin", kind: "extracted" });
    expect(plan.entries[0]?.acquisition).toEqual({ extractedPath: "/work/change.ips", kind: "extracted" });
  });

  it("acquires entries regardless of their optional toggle", () => {
    const plan = buildWeaveApplySessionPlan(
      parsedResult({
        weave: {
          patches: [{ name: "On" }, { name: "Off", optional: true }],
          version: 1,
        },
        patchSources: [{ source: { kind: "url", url: "kept.ips" } }, { source: { kind: "url", url: "retired.ips" } }],
      }),
      WEAVE_URL,
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
    const weave = {
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
    expect(weaveChainEndpointChecks(weave)).toEqual({ input: romChecks, output: finalChecks });
    // A patch's own declared checks win over the endpoint fallbacks.
    expect(
      weaveChainEndpointChecks({
        output: { checks: finalChecks },
        patches: [{ inputChecks: midChecks, outputChecks: midChecks }],
        rom: { checks: romChecks },
        version: 1,
      }),
    ).toEqual({ input: midChecks, output: midChecks });
    // Plan entries are never decorated with inherited rom/output checks - a patch
    // that declared none shows none.
    const plan = buildWeaveApplySessionPlan(
      parsedResult({
        weave,
        patchSources: [{ source: { kind: "url", url: "a.ips" } }, { source: { kind: "url", url: "b.ips" } }],
      }),
      WEAVE_URL,
    );
    expect(plan.chainEndpointChecks).toEqual({ input: romChecks, output: finalChecks });
    expect(plan.entries.map((entry) => [entry.inputChecks, entry.outputChecks])).toEqual([
      [undefined, midChecks],
      [midChecks, undefined],
    ]);
  });

  it("keeps a targeted last patch's lane checks out of the final-output endpoint", () => {
    const romChecks = { checksums: { crc32: "aaaaaaaa" } };
    const trackOneChecks = { checksums: { crc32: "bbbbbbbb" } };
    const trackTwoChecks = { checksums: { crc32: "cccccccc" } };
    const discChecks = { checksums: { crc32: "dddddddd" }, size: 700 };
    const weave = {
      output: { checks: discChecks },
      patches: [
        // Lane 1 writes Track 1; its outputChecks describe that track's raw bytes.
        { outputChecks: trackOneChecks, target: { member: "track01.bin", rom: true as const } },
        // Lane 2 is last and also targeted, so its outputChecks are Track 2's
        // bytes - not the reassembled disc the run produces.
        { outputChecks: trackTwoChecks, target: { member: "track02.bin", rom: true as const } },
      ],
      rom: { checks: romChecks },
      version: 2,
    };
    expect(weaveChainEndpointChecks(weave)).toEqual({ input: romChecks, output: discChecks });
    // With no weave-level output.checks a targeted last patch leaves the
    // endpoint unset rather than promoting the lane checks.
    expect(weaveChainEndpointChecks({ ...weave, output: undefined })).toEqual({ input: romChecks });
    const plan = buildWeaveApplySessionPlan(
      parsedResult({
        weave,
        patchSources: [{ source: { kind: "url", url: "t1.ips" } }, { source: { kind: "url", url: "t2.ips" } }],
      }),
      WEAVE_URL,
    );
    expect(plan.chainEndpointChecks).toEqual({ input: romChecks, output: discChecks });
    // The lane checks survive as per-step verification on their own entries.
    expect(plan.entries.map((entry) => entry.outputChecks)).toEqual([trackOneChecks, trackTwoChecks]);
  });

  it("surfaces the expected ROM when the weave ships none", () => {
    const plan = buildWeaveApplySessionPlan(
      parsedResult({
        weave: {
          patches: [{}],
          rom: { checks: { checksums: { crc32: "aaaaaaaa" }, size: 42 }, name: "Game (USA).nes" },
          version: 1,
        },
        patchSources: [{ source: { kind: "url", url: "change.ips" } }],
      }),
      WEAVE_URL,
    );
    expect(plan.romAcquisition).toBeUndefined();
    expect(plan.romExpectation).toEqual({
      checks: { checksums: { crc32: "aaaaaaaa" }, size: 42 },
      name: "Game (USA).nes",
    });
  });

  it("maps output name and header defaults", () => {
    const withOutput = (output: NonNullable<ParsedWeaveParseResult["weave"]["output"]>) =>
      buildWeaveApplySessionPlan(parsedResult({ weave: { output, patches: [], version: 1 } }), WEAVE_URL)
        .outputDefaults;
    expect(withOutput({ header: "keep", name: "hack v2" })).toEqual({
      header: "keep",
      name: "hack v2",
    });
    expect(withOutput({})).toEqual({});
  });

  it("throws on an unresolvable relative source", () => {
    expect(() =>
      buildWeaveApplySessionPlan(
        parsedResult({
          weave: { patches: [{}], version: 1 },
          patchSources: [{ source: { kind: "url", url: "change.ips" } }],
        }),
        "not a url",
      ),
    ).toThrow(/not resolvable/);
  });
});
