import { describe, expect, it, vi } from "vitest";
import { prepareWeaveCheatPatches } from "../../src/public/react/weave-cheat-export.ts";
import type { CheatRecord } from "../../src/lib/cheats/model.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

const record = (id: string): CheatRecord => ({
  id,
  description: id,
  rawCode: "000010:1234",
  codeKind: "pro-action-replay",
  system: "genesis",
  gameId: "sample",
  rawFields: {},
  sourceFile: "manual",
  sourceIndex: 0,
  sourceRevision: "manual",
});

const setup = () => {
  const dispose = vi.fn().mockResolvedValue(undefined);
  const applyPatch = vi.fn().mockResolvedValue({
    vfs: { normalizePath: (path: string) => path },
    path: "/prefix.bin",
    fileName: "prefix.bin",
    dispose,
  });
  const classify = vi.fn(async ({ records }) => ({
    patches: records.map(() => ({ bytes: [80, 65, 84, 67, 72, 69, 79, 70], format: "ips" })),
  }));
  const options = {
    runtime: { patch: { applyPatch }, cheat: { run: classify } } as unknown as WorkflowRuntime,
    rom: new File([new Uint8Array(32)], "rom.bin"),
    patches: [
      {
        id: "original",
        fileName: "original.ips",
        source: new File([], "original.ips"),
        target: { rom: true as const },
      },
    ],
    patchBasis: "base" as const,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  };
  return { options, applyPatch, classify, dispose };
};

describe("weave cheat patch preparation", () => {
  it("groups same-position codes and resolves later groups against all preceding active steps", async () => {
    const { options, applyPatch, classify, dispose } = setup();
    const prepared = await prepareWeaveCheatPatches({
      ...options,
      cheats: [
        { record: record("before"), position: 0 },
        { record: record("after-a"), position: 1 },
        { record: record("after-b"), position: 1 },
      ],
    });
    expect(prepared.map((patch) => patch.name || patch.id)).toEqual(["before", "original", "after-a", "after-b"]);
    expect(classify.mock.calls.map(([input]) => input.records.map(({ id }) => id))).toEqual([
      ["before"],
      ["after-a", "after-b"],
    ]);
    expect(classify.mock.calls[0][0].source).toBe(options.rom);
    expect(classify.mock.calls[1][0].source).toMatchObject({ path: "/prefix.bin" });
    expect(applyPatch).toHaveBeenCalledOnce();
    expect(applyPatch.mock.calls[0][0].options).toMatchObject({
      defaultPatchBasis: "base",
      patchBasis: ["previous", "base"],
      patchTargets: [{ rom: true }, { rom: true }],
      outputHeader: "keep",
    });
    expect(prepared[0]).toMatchObject({ header: "keep", basis: "previous", target: { rom: true } });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("gates stale output checks after an optional entry while preserving export metadata", async () => {
    const { options, applyPatch } = setup();
    const patches = [
      { ...options.patches[0], id: "off", optional: true, outputChecks: "crc32=11111111" },
      { ...options.patches[0], id: "on", outputChecks: "crc32=22222222" },
    ];
    const prepared = await prepareWeaveCheatPatches({
      ...options,
      patches,
      cheats: [{ record: record("after"), position: 2 }],
    });
    expect(applyPatch.mock.calls[0][0].options.patchIds).toEqual(["on"]);
    expect(applyPatch.mock.calls[0][0].options.patchOutputChecks).toEqual([""]);
    expect(prepared.slice(0, 2)).toEqual(patches);
  });

  it("rejects invalid positions and an aborted export before running workers", async () => {
    const { options, classify, applyPatch } = setup();
    await expect(
      prepareWeaveCheatPatches({ ...options, cheats: [{ record: record("bad"), position: 2 }] }),
    ).rejects.toThrow("Cheat position 2 exceeds the 1 patch steps");
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareWeaveCheatPatches({
        ...options,
        signal: controller.signal,
        cheats: [{ record: record("aborted"), position: 0 }],
      }),
    ).rejects.toThrow();
    expect(classify).not.toHaveBeenCalled();
    expect(applyPatch).not.toHaveBeenCalled();
  });
});
