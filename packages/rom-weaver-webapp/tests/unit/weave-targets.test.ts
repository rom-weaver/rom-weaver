import { parseWeaveCreateResult, parseWeaveParseResult } from "../../src/lib/runtime/weave-result.ts";
import { describe, expect, it } from "vitest";
import {
  compareWeaveRomChecks,
  gateWeaveChainChecks,
  readsWeaveRootRom,
  selectWeaveMembers,
  validatePatchDependencies,
} from "../../src/lib/weave/weave-targets.ts";
import { buildWeaveApplySessionPlan } from "../../src/lib/weave/weave-session-model.ts";
import type { ParsedWeave } from "../../src/types/weave.ts";

describe("weave state references", () => {
  const checks = { checksums: { crc32: "12345678" }, size: 42 };
  const weave: ParsedWeave = {
    version: 2,
    patchBasis: "auto",
    checkStates: [{ id: "rom", checks }],
    rom: { checksRef: "rom" },
    patches: [{ id: "a", path: "a.ips", input: { rom: true }, inputChecksRef: "rom" }],
  };

  it("shows shared checks at the ROM and consuming patch from the Rust-resolved parse result", () => {
    const parsed = parseWeaveParseResult({
      weave: {
        weave: weave as never,
        source_kind: "json",
        rom_checks: checks,
        patch_sources: [{ source: { path: "a.ips" }, input_checks: checks }],
        warnings: [],
      },
    });
    expect(parsed).toBeDefined();
    if (!parsed) return;
    const plan = buildWeaveApplySessionPlan(parsed, "https://example.test/weave.json");
    expect(plan.romExpectation?.checks).toEqual(checks);
    expect(plan.entries[0]?.inputChecks).toEqual(checks);
    expect(plan.entries[0]?.input).toEqual({ rom: true });
    expect(plan.chainEndpointChecks.input).toEqual(checks);
  });

  it("retains references and track locators at the Rust boundary", () => {
    const wireWeave = {
      ...weave,
      rom: { member: "disc/track03.bin", checksRef: "rom" },
      patches: [{ ...weave.patches[0], input: { rom: true, member: "disc/track03.bin" } }],
      output: { checksRef: "rom" },
    };
    const result = parseWeaveCreateResult({
      weave_create: {
        weave_path: "/work/rom-weaver-weave.json",
        weave: wireWeave,
      },
    });
    expect(result?.weave).toEqual(wireWeave);
  });
});

describe("stable patch dependencies", () => {
  const a = { id: "a", enabled: true };
  const b = { id: "b", enabled: true, input: { patch: "a" } };

  it("retains the named producer when unrelated patches move", () => {
    expect(validatePatchDependencies([a, { id: "other", enabled: true }, b])).toBeUndefined();
    expect(validatePatchDependencies([{ id: "other", enabled: true }, a, b])).toBeUndefined();
  });

  it("blocks a removed, disabled, or later producer", () => {
    expect(validatePatchDependencies([b])).toContain("requires output from a");
    expect(validatePatchDependencies([{ ...a, enabled: false }, b])).toContain("requires output from a");
    expect(validatePatchDependencies([b, a])).toContain("requires output from a");
  });

  it("blocks a missing producer selected as an output target", () => {
    const targeted = { id: "targeted", enabled: true, target: { patch: "a" } };
    expect(validatePatchDependencies([targeted])).toContain("requires output from a");
    expect(validatePatchDependencies([{ ...a, enabled: false }, targeted])).toContain("requires output from a");
    expect(validatePatchDependencies([targeted, a])).toContain("requires output from a");
  });

  it("rejects self references and duplicate identities", () => {
    expect(validatePatchDependencies([{ ...a, input: { patch: "a" } }])).toContain("requires output from a");
    expect(validatePatchDependencies([a, a])).toContain("duplicated");
  });

  it("does not require the dependency of a disabled patch", () => {
    expect(validatePatchDependencies([{ ...b, enabled: false }])).toBeUndefined();
  });
});

describe("weave member selection", () => {
  const track = {
    type: "file" as const,
    id: "track",
    path: "disc/track03.bin",
    fileName: "track03.bin",
    kind: "track" as const,
    selectable: true,
  };

  it("automatically selects an exact member despite another same-named track", () => {
    expect(
      selectWeaveMembers(
        ["disc/track03.bin"],
        [
          track,
          {
            ...track,
            id: "other",
            path: "other/track03.bin",
          },
        ],
      ),
    ).toEqual({ id: "track", ids: ["track"] });
  });

  it("leaves ambiguous or missing names for the selection dialog", () => {
    expect(selectWeaveMembers(["track03.bin"], [track, { ...track, id: "other" }])).toBeUndefined();
    expect(selectWeaveMembers(["missing.bin"], [track])).toBeUndefined();
  });

  it("selects the owning disc group when a track cannot be selected alone", () => {
    expect(
      selectWeaveMembers(
        ["disc/track03.bin"],
        [
          { ...track, selectable: false },
          {
            type: "group",
            id: "disc",
            label: "Disc",
            kind: "cue-disc",
            candidateIds: ["track"],
            selectable: true,
            warnings: [],
          },
        ],
      ),
    ).toEqual({ id: "disc", ids: ["disc"] });
  });
});

describe("weave chain check gating", () => {
  const entry = (overrides: Partial<Parameters<typeof gateWeaveChainChecks>[0][number]>) => ({
    enabled: true,
    authoredInputChecks: true,
    inputChecks: "crc32=11111111",
    outputChecks: "crc32=22222222",
    ...overrides,
  });

  it("drops output checks after a disabled entry in the same lane only", () => {
    const track = { rom: true as const, member: "track02.bin" };
    expect(gateWeaveChainChecks([entry({ enabled: false }), entry({}), entry({ target: track }), entry({})])).toEqual([
      { inputChecks: "crc32=11111111", outputChecks: "crc32=22222222" },
      { inputChecks: "crc32=11111111", outputChecks: undefined },
      { inputChecks: "crc32=11111111", outputChecks: "crc32=22222222" },
      { inputChecks: "crc32=11111111", outputChecks: undefined },
    ]);
  });

  it("keeps the checks of a non-prefix entry that names its own input, except the final root output", () => {
    const own = { patch: "a" };
    expect(
      gateWeaveChainChecks([entry({ enabled: false }), entry({ input: own }), entry({ input: own })]).map(
        (gated) => gated.outputChecks,
      ),
    ).toEqual(["crc32=22222222", "crc32=22222222", undefined]);
    const track = { rom: true as const, member: "track02.bin" };
    expect(
      gateWeaveChainChecks([
        entry({ enabled: false, target: track }),
        entry({ target: track, input: { rom: true } }),
      ])[1],
    ).toEqual({ inputChecks: "crc32=11111111", outputChecks: "crc32=22222222" });
  });

  it("drops authored input checks only at a member lane start that is not a chain prefix", () => {
    const track = { rom: true as const, member: "track02.bin" };
    expect(
      gateWeaveChainChecks([
        entry({ enabled: false, target: track }),
        entry({ target: track }),
        entry({ target: track }),
      ]).map((gated) => gated.inputChecks),
    ).toEqual(["crc32=11111111", undefined, "crc32=11111111"]);
    // Identify-database fills describe the raw member and always travel.
    expect(
      gateWeaveChainChecks([
        entry({ enabled: false, target: track }),
        entry({ target: track, authoredInputChecks: false }),
      ])[1]?.inputChecks,
    ).toBe("crc32=11111111");
  });
});

describe("readsWeaveRootRom", () => {
  it("matches the CLI's root-ROM rule for input and target", () => {
    const member = { member: "track02.bin", rom: true as const };
    expect(readsWeaveRootRom({}, undefined)).toBe(true);
    // The browser export writes `target: {rom: true}` on every patch; it still reads the ROM.
    expect(readsWeaveRootRom({ target: { rom: true } }, undefined)).toBe(true);
    expect(readsWeaveRootRom({ target: member }, undefined)).toBe(false);
    expect(readsWeaveRootRom({ input: { patch: "a" } }, undefined)).toBe(false);
    expect(readsWeaveRootRom({ input: member }, undefined)).toBe(false);
    expect(readsWeaveRootRom({ input: member }, "track02.bin")).toBe(true);
  });
});

describe("compareWeaveRomChecks", () => {
  const file = { checksums: { crc32: "3E30B9B3", md5: "df0e", sha1: "22f5" }, size: 24592 };

  it("compares every token the file can answer", () => {
    expect(compareWeaveRomChecks("crc32=3e30b9b3,sha1=22f5,size=24592", file)).toEqual({
      missing: [],
      status: "match",
    });
    expect(compareWeaveRomChecks("crc32=3e30b9b3,size=24576", file)).toEqual({
      message: "Input size mismatch; expected 24576, actual 24592",
      missing: [],
      status: "mismatch",
    });
    expect(compareWeaveRomChecks("crc32=a1cecd74", file)).toEqual({
      message: "Input checksum mismatch for crc32; expected a1cecd74, actual 3e30b9b3",
      missing: [],
      status: "mismatch",
    });
  });

  it("lists algorithms the file cannot answer for the caller to compute", () => {
    expect(compareWeaveRomChecks("sha256=abcd", file)).toEqual({ missing: ["sha256"], status: "unknown" });
    expect(compareWeaveRomChecks("crc32=3e30b9b3,size=24592", {})).toEqual({ missing: ["crc32"], status: "unknown" });
    expect(compareWeaveRomChecks("sha256=abcd,crc32=3e30b9b3", file)).toEqual({
      missing: ["sha256"],
      status: "match",
    });
  });
});
