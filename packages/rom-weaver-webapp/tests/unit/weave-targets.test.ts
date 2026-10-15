import { parseWeaveCreateResult } from "../../src/lib/runtime/weave-result.ts";
import { describe, expect, it } from "vitest";
import {
  firstRootRomPatchIndex,
  gateWeaveChainChecks,
  resolveWeaveChecks,
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

  it("shows shared checks at the ROM and consuming patch without copying stored values", () => {
    const plan = buildWeaveApplySessionPlan(
      {
        weave,
        patchSources: [{ source: { kind: "path", path: "a.ips" } }],
        sourceKind: "json",
        warnings: [],
      },
      "https://example.test/weave.json",
    );
    expect(plan.romExpectation?.checks).toEqual(checks);
    expect(plan.entries[0]?.inputChecks).toEqual(checks);
    expect(plan.entries[0]?.input).toEqual({ rom: true });
    expect(weave.patches[0]?.inputChecks).toBeUndefined();
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

  it("rejects missing, duplicate, and conflicting check references", () => {
    expect(() => resolveWeaveChecks(weave, undefined, "missing")).toThrow("missing or duplicated");
    expect(() => resolveWeaveChecks(weave, checks, "rom")).toThrow("both values and a reference");
    expect(() => resolveWeaveChecks(weave, checks, "missing")).toThrow("both values and a reference");
    expect(() =>
      resolveWeaveChecks(
        {
          ...weave,
          checkStates: [
            { id: "rom", checks },
            { id: "rom", checks },
          ],
        },
        undefined,
        "rom",
      ),
    ).toThrow("missing or duplicated");
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

describe("firstRootRomPatchIndex", () => {
  it("picks the first enabled patch that reads the supplied ROM", () => {
    const member = { rom: true as const, member: "track02.bin" };
    expect(firstRootRomPatchIndex([{ enabled: true }, { enabled: true }])).toBe(0);
    expect(firstRootRomPatchIndex([{ enabled: false }, { enabled: true, target: { rom: true } }])).toBe(1);
    expect(
      firstRootRomPatchIndex([
        { enabled: true, input: { patch: "a" } },
        { enabled: true, target: member },
      ]),
    ).toBe(-1);
    expect(firstRootRomPatchIndex([])).toBe(-1);
  });
});
