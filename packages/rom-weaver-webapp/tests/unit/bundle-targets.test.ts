import { parseBundleCreateResult } from "../../src/lib/runtime/bundle-result.ts";
import { describe, expect, it } from "vitest";
import {
  resolveBundleChecks,
  selectBundleMembers,
  validatePatchDependencies,
} from "../../src/lib/bundle/bundle-targets.ts";
import { buildBundleApplySessionPlan } from "../../src/lib/bundle/bundle-session-model.ts";
import type { ParsedBundle } from "../../src/types/bundle.ts";

describe("bundle state references", () => {
  const checks = { checksums: { crc32: "12345678" }, size: 42 };
  const bundle: ParsedBundle = {
    version: 2,
    patchBasis: "auto",
    checkStates: [{ id: "rom", checks }],
    rom: { checksRef: "rom" },
    patches: [{ id: "a", path: "a.ips", input: { rom: true }, inputChecksRef: "rom" }],
  };

  it("shows shared checks at the ROM and consuming patch without copying stored values", () => {
    const plan = buildBundleApplySessionPlan(
      {
        bundle,
        patchSources: [{ source: { kind: "path", path: "a.ips" } }],
        sourceKind: "json",
        warnings: [],
      },
      "https://example.test/bundle.json",
    );
    expect(plan.romExpectation?.checks).toEqual(checks);
    expect(plan.entries[0]?.inputChecks).toEqual(checks);
    expect(plan.entries[0]?.input).toEqual({ rom: true });
    expect(bundle.patches[0]?.inputChecks).toBeUndefined();
  });

  it("retains references and track locators at the Rust boundary", () => {
    const wireBundle = {
      ...bundle,
      rom: { member: "disc/track03.bin", checksRef: "rom" },
      patches: [{ ...bundle.patches[0], input: { rom: true, member: "disc/track03.bin" } }],
      output: { checksRef: "rom" },
    };
    const result = parseBundleCreateResult({
      bundle_create: {
        bundle_path: "/work/rom-weaver-bundle.json",
        bundle: wireBundle,
      },
    });
    expect(result?.bundle).toEqual(wireBundle);
  });

  it("rejects missing, duplicate, and conflicting check references", () => {
    expect(() => resolveBundleChecks(bundle, undefined, "missing")).toThrow("missing or duplicated");
    expect(() => resolveBundleChecks(bundle, checks, "rom")).toThrow("both values and a reference");
    expect(() => resolveBundleChecks(bundle, checks, "missing")).toThrow("both values and a reference");
    expect(() =>
      resolveBundleChecks(
        {
          ...bundle,
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

describe("bundle member selection", () => {
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
      selectBundleMembers(
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
    expect(selectBundleMembers(["track03.bin"], [track, { ...track, id: "other" }])).toBeUndefined();
    expect(selectBundleMembers(["missing.bin"], [track])).toBeUndefined();
  });

  it("selects the owning disc group when a track cannot be selected alone", () => {
    expect(
      selectBundleMembers(
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
