import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeRomWeaverPlaylistPlan,
  invokeRomWeaverPlaylistWrite,
} from "../../src/lib/runtime/wasm-playlist-commands.ts";

const { runJson } = vi.hoisted(() => ({ runJson: vi.fn() }));
vi.mock("../../src/lib/runtime/wasm-command-shared.ts", () => ({ runRomWeaverJson: runJson }));

const PLAN = {
  bundle: [{ path: "Game.m3u" }, { path: "Game (Disc 1).cue", source: "/g/a.cue", text: "FILE" }],
  discs: [],
  entries: [],
  file_name: "Game.m3u",
  renames: [],
  text: "",
};

const succeeded = (plan: unknown) => ({
  events: [{ details: { playlist: plan }, status: "succeeded" }],
  exitCode: 0,
  ok: true,
  stderr: "",
});

const input = {
  chd: true,
  codec: "store",
  inputs: ["/g/a.cue"],
  knownPaths: ["/g/a.cue"],
  layout: "folder",
  name: "Game",
  output: "/o/Game.zip",
  rename: true,
} as const;

beforeEach(() => runJson.mockReset());

describe("playlist commands", () => {
  it("plans and writes with the same command, so the preview matches the run", async () => {
    runJson.mockResolvedValue(succeeded(PLAN));
    await invokeRomWeaverPlaylistPlan(input);
    await invokeRomWeaverPlaylistWrite(input);

    const [plan, write] = runJson.mock.calls.map(([request]) => request);
    expect(plan.dry_run).toBe(true);
    expect(write.dry_run).toBe(false);
    expect(write.command).toEqual(plan.command);
    expect(plan.command).toMatchObject({
      args: { chd: true, codec: "store", layout: "folder", name: "Game", output: "/o/Game.zip", rename: true },
    });
  });

  it("returns the plan's bundle", async () => {
    runJson.mockResolvedValue(succeeded(PLAN));
    expect((await invokeRomWeaverPlaylistPlan(input)).bundle).toEqual(PLAN.bundle);
  });

  it.each([{ bundle: undefined }, { bundle: [{ source: "/g/a.cue" }] }, { bundle: [{ path: "a", source: 1 }] }])(
    "rejects a plan with a malformed bundle $bundle",
    async ({ bundle }) => {
      runJson.mockResolvedValue(succeeded({ ...PLAN, bundle }));
      await expect(invokeRomWeaverPlaylistPlan(input)).rejects.toThrow("The playlist plan is missing or malformed.");
    },
  );

  it("fails the write when the engine fails", async () => {
    runJson.mockResolvedValue({ events: [], exitCode: 1, ok: false, stderr: "disk full" });
    await expect(invokeRomWeaverPlaylistWrite(input)).rejects.toThrow();
  });
});
