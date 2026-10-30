import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPbp, buildPbpDiscBytes } from "../wasm/pbp-fixture.mjs";
import { preparePbpEmulatorBundle } from "../../src/platform/browser/emulator-pbp-bundle.ts";
import type { RuntimeWorkerIo } from "../../src/types/workflow-runtime-adapter.ts";

const state = vi.hoisted(() => ({
  checksum: vi.fn(),
  cleanup: vi.fn(),
  extract: vi.fn(),
  readBlob: vi.fn(),
  run: vi.fn(),
  stage: vi.fn(),
  stagedCleanup: vi.fn(),
  stat: vi.fn(),
  count: 2,
  scopes: 0,
}));
vi.mock("../../src/storage/browser/browser-opfs-cleanup.ts", () => ({
  waitForBrowserOpfsBootCleanup: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/runtime/run-output-paths.ts", () => ({
  createRomWeaverOutputScope: () => {
    const rootPath = `/work/operations/pbp-${++state.scopes}`;
    return { rootPath, cleanup: () => state.cleanup(rootPath) };
  },
}));
vi.mock("../../src/lib/runtime/wasm-compression-commands.ts", () => ({
  invokeRomWeaverExtractAllWorker: state.extract,
}));
vi.mock("../../src/lib/runtime/wasm-checksum-command.ts", () => ({ invokeRomWeaverChecksumWorker: state.checksum }));
vi.mock("../../src/workers/rom-weaver/rom-weaver-runner.ts", () => ({ runRomWeaverJson: state.run }));
vi.mock("../../src/storage/vfs/runtime-output.ts", () => ({ readRuntimeOutputBlob: state.readBlob }));
vi.mock("../../src/platform/browser/workflow-runtime-vfs-cleanup.ts", () => ({ browserVfs: { stat: state.stat } }));

const workerIo = { stageSource: state.stage } as unknown as RuntimeWorkerIo;
const disc = { discId: "SLUS00001", iso: buildPbpDiscBytes(32, 7) };
const source = () => new Blob([buildPbp(Array.from({ length: state.count }, () => disc))]);
const outputs = (root: string) =>
  Array.from({ length: state.count }, (_, index) =>
    ["cue", "bin"].map((ext) => {
      const fileName = `Game.disc${String(index + 1).padStart(2, "0")}.${ext}`;
      return { fileName, filePath: `${root}/${fileName}`, size: ext === "bin" ? disc.iso.length : 100 };
    }),
  ).flat();

beforeEach(() => {
  vi.resetAllMocks();
  state.count = 2;
  state.scopes = 0;
  state.cleanup.mockResolvedValue(undefined);
  state.stagedCleanup.mockResolvedValue(undefined);
  state.stage.mockResolvedValue({ filePath: "/work/input.pbp", cleanup: state.stagedCleanup });
  state.extract.mockImplementation(async ({ outDirPath }) => outputs(outDirPath));
  state.checksum.mockResolvedValue({ checksums: { sha1: "a".repeat(40) } });
  state.run.mockResolvedValue({ ok: true, exitCode: 0, events: [] });
  state.stat.mockResolvedValue({ size: 3 });
  state.readBlob.mockResolvedValue(new Blob(["zip"]));
});

describe("stored-block PBP emulator preparation", () => {
  it("overrides a File name before staging while preserving every byte", async () => {
    const blob = new File([await source().arrayBuffer()], "#Game.pbp");
    await preparePbpEmulatorBundle(workerIo, blob, "#Game.pbp", 2);
    const staged = state.stage.mock.calls[0]?.[0];
    expect(staged.source.name).toBe("game.pbp");
    expect(staged.fallbackFileName).toBe("game.pbp");
    expect(await staged.source.arrayBuffer()).toEqual(await blob.arrayBuffer());
  });

  it.each([1, 2, 5])("bundles all %i complete discs through Rust playlist", async (count) => {
    state.count = count;
    const blob = source();
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const result = await preparePbpEmulatorBundle(workerIo, blob, "Game v1.2 雨 #2.PBP", count, { onProgress, signal });
    expect(result).toEqual({
      blob: await state.readBlob.mock.results[0]?.value,
      checksum: "a".repeat(40),
      expandedSizeBytes: count * (disc.iso.length + 100),
    });
    expect(state.stage).toHaveBeenCalledWith(expect.objectContaining({ fallbackFileName: "game.pbp" }));
    expect(state.extract).toHaveBeenCalledWith(
      expect.objectContaining({ interactiveSelectionEnabled: false, noIgnore: true, signal }),
      onProgress,
    );
    const files = outputs("/work/operations/pbp-1/discs");
    const [command, options] = state.run.mock.calls[0] || [];
    expect(command).toEqual({
      type: "playlist",
      args: {
        input: files.filter((entry) => entry.fileName.endsWith(".cue")).map((entry) => entry.filePath),
        output: `/work/operations/pbp-1/${"a".repeat(40)}.zip`,
        layout: "flat",
        staged_paths: Object.fromEntries(files.map((entry) => [entry.filePath, entry.filePath])),
      },
    });
    expect(options).toMatchObject({
      knownInputPaths: files.map((entry) => entry.filePath),
      signal,
      invalidateMountCacheBeforeRun: true,
      interactiveSelectionEnabled: false,
    });
    expect(state.checksum).toHaveBeenCalledWith(
      expect.objectContaining({
        algorithms: ["sha1"],
        autoExtract: false,
        signal,
        sourcePath: count === 1 ? files[1]?.filePath : "/work/input.pbp",
      }),
    );
    expect(state.readBlob).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/work/operations/pbp-1/${"a".repeat(40)}.zip`, size: 3 }),
      signal,
    );
    expect(state.cleanup).toHaveBeenCalledExactlyOnceWith("/work/operations/pbp-1");
    expect(state.stagedCleanup).toHaveBeenCalledOnce();
  });

  it("refuses a partial disc set before packaging and cleans its files", async () => {
    state.extract.mockImplementation(async ({ outDirPath }) => outputs(outDirPath).slice(0, -1));
    await expect(preparePbpEmulatorBundle(workerIo, source(), "Game.pbp", 2)).rejects.toThrow(
      "every disc and cue sheet",
    );
    expect(state.run).not.toHaveBeenCalled();
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.stagedCleanup).toHaveBeenCalledOnce();
  });

  it.each(["extract", "checksum", "run", "readBlob"] as const)(
    "preserves cancellation during %s and cleans up",
    async (step) => {
      const error = new DOMException("Cancelled", "AbortError");
      state[step].mockRejectedValue(error);
      state.cleanup.mockRejectedValue(new Error("cleanup failed"));
      state.stagedCleanup.mockRejectedValue(new Error("staging cleanup failed"));
      await expect(preparePbpEmulatorBundle(workerIo, source(), "Game.pbp", 2)).rejects.toBe(error);
      expect(state.cleanup).toHaveBeenCalledOnce();
      expect(state.stagedCleanup).toHaveBeenCalledOnce();
    },
  );

  it("cleans up a late staged result after cancellation", async () => {
    let resolveStage!: (value: unknown) => void;
    state.stage.mockReturnValue(
      new Promise((resolve) => {
        resolveStage = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = preparePbpEmulatorBundle(workerIo, source(), "Game.pbp", 2, { signal: controller.signal });
    controller.abort();
    resolveStage({ filePath: "/work/input.pbp", cleanup: state.stagedCleanup });
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.stagedCleanup).toHaveBeenCalledOnce();
    expect(state.cleanup).toHaveBeenCalledOnce();
  });

  it("reports real quota failures without returning a partial bundle", async () => {
    state.extract.mockRejectedValue(new DOMException("Quota exceeded", "QuotaExceededError"));
    await expect(preparePbpEmulatorBundle(workerIo, source(), "Game.pbp", 2)).rejects.toMatchObject({
      code: "OUTPUT_WRITE_FAILED",
      message: expect.stringContaining("every PBP disc"),
    });
    expect(state.readBlob).not.toHaveBeenCalled();
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.stagedCleanup).toHaveBeenCalledOnce();
  });

  it("reports memory failure while copying a large archive", async () => {
    state.readBlob.mockRejectedValue(new RangeError("Array buffer allocation failed"));
    await expect(preparePbpEmulatorBundle(workerIo, source(), "Game.pbp", 2)).rejects.toMatchObject({
      message: expect.stringContaining("more memory"),
    });
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.stagedCleanup).toHaveBeenCalledOnce();
  });

  it("keeps concurrent preparations in separate operation scopes", async () => {
    await Promise.all([
      preparePbpEmulatorBundle(workerIo, source(), "A.pbp", 2),
      preparePbpEmulatorBundle(workerIo, source(), "B.pbp", 2),
    ]);
    expect(state.cleanup.mock.calls.map(([path]) => path).sort((left, right) => left.localeCompare(right))).toEqual([
      "/work/operations/pbp-1",
      "/work/operations/pbp-2",
    ]);
    expect(
      state.run.mock.calls.map(([command]) => command.args.output).sort((left, right) => left.localeCompare(right)),
    ).toEqual([`/work/operations/pbp-1/${"a".repeat(40)}.zip`, `/work/operations/pbp-2/${"a".repeat(40)}.zip`]);
  });

  it("rejects a failed or empty playlist archive", async () => {
    state.run.mockResolvedValueOnce({
      ok: false,
      exitCode: 2,
      events: [{ status: "failed", label: "playlist companion missing" }],
    });
    await expect(preparePbpEmulatorBundle(workerIo, source(), "Game.pbp", 2)).rejects.toThrow(
      "playlist companion missing",
    );
    state.stat.mockResolvedValueOnce({ size: 0 });
    await expect(preparePbpEmulatorBundle(workerIo, source(), "Game.pbp", 2)).rejects.toThrow("missing or empty");
    expect(state.readBlob).not.toHaveBeenCalled();
    expect(state.cleanup).toHaveBeenCalledTimes(2);
  });
});
