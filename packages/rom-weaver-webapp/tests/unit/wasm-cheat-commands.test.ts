import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeRomWeaverCheatWorker } from "../../src/lib/runtime/wasm-cheat-commands.ts";

const { runJson } = vi.hoisted(() => ({ runJson: vi.fn() }));
vi.mock("../../src/workers/rom-weaver/rom-weaver-runner.ts", () => ({ runRomWeaverJson: runJson }));

const response = (patches?: unknown) => ({
  ok: true,
  exitCode: 0,
  stderr: "",
  events: [
    {
      status: "succeeded",
      details: { cheats: { records: [{}], conflicts: [], ...(patches === undefined ? {} : { patches }) } },
    },
  ],
});

beforeEach(() => runJson.mockReset());

describe("cheat patch snapshot boundary", () => {
  it("requests snapshots and forwards aligned patch bytes", async () => {
    const patches = [{ bytes: [80, 65, 84, 67, 72, 69, 79, 70], format: "ips" }];
    runJson.mockResolvedValue(response(patches));
    const result = await invokeRomWeaverCheatWorker({ inputPath: "/rom.bin", records: [], exportPatches: true });
    expect(runJson.mock.calls[0][0]).toEqual({
      type: "cheat",
      args: { input: "/rom.bin", records: [], exportPatches: true },
    });
    expect(result.patches).toEqual(patches);
  });

  it.each(
    [
      [],
      [{ bytes: [256], format: "ips" }],
      [{ bytes: [-1], format: "ips" }],
      [{ bytes: [1.5], format: "ips" }],
      [{ bytes: [], format: "ips" }],
      [{ bytes: [80], format: "bps" }],
    ].map((patches) => ({ patches })),
  )("rejects malformed snapshot data $patches", async ({ patches }) => {
    runJson.mockResolvedValue(response(patches));
    await expect(
      invokeRomWeaverCheatWorker({ inputPath: "/rom.bin", records: [], exportPatches: true }),
    ).rejects.toThrow("Cheat patch snapshots were malformed");
  });

  it("accepts ordinary classification but rejects snapshot requests against an older worker", async () => {
    runJson.mockResolvedValue(response());
    await expect(invokeRomWeaverCheatWorker({ inputPath: "/rom.bin", records: [] })).resolves.not.toHaveProperty(
      "patches",
    );
    await expect(
      invokeRomWeaverCheatWorker({ inputPath: "/rom.bin", records: [], exportPatches: true }),
    ).rejects.toThrow("The cheat worker did not return patch snapshots; rebuild the WASM runtime");
  });
});
