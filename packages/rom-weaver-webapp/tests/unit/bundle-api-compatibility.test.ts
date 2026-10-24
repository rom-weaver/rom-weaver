import { describe, expect, it, vi } from "vitest";
import { createRomWeaverCommand, collectRomWeaverRunInputPaths } from "../../src/wasm/index.ts";
import type { RomWeaverCommandBranchArgs } from "../../src/wasm/index.ts";
import { createBundleRuntime, getWeaveRuntime } from "../../src/lib/runtime/bundle-runtime.ts";
import { parseBundleCreateResult, parseBundleParseResult } from "../../src/lib/runtime/bundle-result.ts";

describe("bundle API compatibility", () => {
  it("preserves legacy result fields from either wire spelling", () => {
    const bundle = { version: 2, patchBasis: "base", patches: [{ id: "first", target: { rom: true } }] };
    for (const name of ["bundle", "weave"]) {
      expect(parseBundleParseResult({ [name]: { [name]: bundle, source_kind: "json", warnings: [] } })).toMatchObject({
        bundle,
        sourceKind: "json",
      });
      expect(
        parseBundleCreateResult({
          [`${name}_create`]: { [name]: bundle, [`${name}_path`]: "/work/pack.json", warnings: [] },
        }),
      ).toMatchObject({ bundle, bundlePath: "/work/pack.json" });
    }
  });

  it("maps packaged ROM, archive, omission and output fields for old callers", async () => {
    const weave = { version: 2, patches: [] };
    const weaveOutput = { fileName: "pack.json" };
    const archiveOutput = { fileName: "pack.7z" };
    const create = vi
      .fn()
      .mockResolvedValue({ weaveOutput, archiveOutput, result: { weave, weavePath: "/work/pack.json", warnings: [] } });
    const cleanup = vi.fn();
    const extractedFiles = new Map();
    const parse = vi.fn().mockResolvedValue({
      cleanup,
      extractedFiles,
      result: { weave, patchSources: [], sourceKind: "json", warnings: [] },
    });
    const runtime = createBundleRuntime({ create, parse });
    const bundleRom = { source: "packed-rom", fileName: "game.chd" };
    const created = await runtime.create?.({ bundleRom, bundleFileName: "pack.7z", noBundleRom: true, patches: [] });
    expect(create).toHaveBeenCalledWith({
      weaveRom: bundleRom,
      weaveFileName: "pack.7z",
      noWeaveRom: true,
      patches: [],
    });
    expect(created).toMatchObject({
      bundleOutput: weaveOutput,
      archiveOutput,
      result: { bundle: weave, bundlePath: "/work/pack.json" },
    });
    const parsed = await runtime.parse?.({ source: "pack.json" });
    expect(parsed).toMatchObject({ cleanup, extractedFiles, result: { bundle: weave } });
  });
});

it("adapts a custom runtime implementing only bundle", async () => {
  const bundle = { version: 1, patches: [] };
  const bundleOutput = { fileName: "rom-weaver-bundle.json" };
  const create = vi
    .fn()
    .mockResolvedValue({ bundleOutput, result: { bundle, bundlePath: "/work/bundle.json", warnings: [] } });
  const parse = vi.fn().mockResolvedValue({
    extractedFiles: new Map(),
    cleanup: vi.fn(),
    result: { bundle, patchSources: [], sourceKind: "json", warnings: [] },
  });
  const runtime = getWeaveRuntime({ bundle: { create, parse } });
  const weaveRom = { source: "game.chd" };
  const created = await runtime?.create?.({ patches: [], weaveRom, weaveFileName: "pack.zip", noWeaveRom: false });
  expect(create).toHaveBeenCalledWith({
    patches: [],
    bundleRom: weaveRom,
    bundleFileName: "pack.zip",
    noBundleRom: false,
  });
  expect(created).toMatchObject({
    weaveOutput: bundleOutput,
    result: { weave: bundle, weavePath: "/work/bundle.json" },
  });
  expect(await runtime?.parse?.({ source: "bundle.json" })).toMatchObject({ result: { weave: bundle } });
});

it("preserves the old typed command argument contracts", () => {
  const args: RomWeaverCommandBranchArgs<"bundle-create"> = {
    rom: "/work/logical.bin",
    bundle_rom: "/work/game.chd",
    bundle: "/work/pack.zip",
    output: "/work/pack.json",
    patch: ["/work/fix.ips"],
    no_bundle_rom: true,
  };
  const command = createRomWeaverCommand("bundle-create", args);
  expect(command).toMatchObject({
    type: "bundle",
    args: { type: "create", args: { bundle_rom: "/work/game.chd", bundle: "/work/pack.zip", no_bundle_rom: true } },
  });
  expect(collectRomWeaverRunInputPaths(command)).toContain("/work/game.chd");
});

it("keeps absent capabilities and omits undefined aliases without dropping false flags", async () => {
  expect(createBundleRuntime({})).toEqual({});
  expect(getWeaveRuntime({ bundle: {} })).toEqual({});
  const weave = { version: 1, patches: [] };
  const create = vi
    .fn()
    .mockResolvedValue({ result: { weave, weavePath: "pack.json", warnings: [] }, weaveOutput: {}, archiveOutput: {} });
  const bundle = createBundleRuntime({ create });
  expect(Object.hasOwn(bundle, "parse")).toBe(false);
  await bundle.create?.({ patches: [], bundleRom: undefined, bundleFileName: undefined, noBundleRom: false });
  expect(create).toHaveBeenCalledWith({ patches: [], noWeaveRom: false });
  const legacyCreate = vi
    .fn()
    .mockResolvedValue({ result: { bundle: weave, bundlePath: "pack.json", warnings: [] }, bundleOutput: {} });
  const runtime = getWeaveRuntime({ bundle: { create: legacyCreate } });
  expect(Object.hasOwn(runtime ?? {}, "parse")).toBe(false);
  await runtime?.create?.({ patches: [], weaveRom: undefined, weaveFileName: undefined, noWeaveRom: false });
  expect(legacyCreate).toHaveBeenCalledWith({ patches: [], noBundleRom: false });
});
