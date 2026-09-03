import { beforeEach, describe, expect, it, vi } from "vitest";
import { StagedRomSourceController } from "../../src/lib/workflow/staged-rom-source.ts";
import type { SharedRomSourceState, SharedRomSourceSession } from "../../src/lib/workflow/staged-source-types.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";

const prep = vi.hoisted(() => ({
  getBinarySourceSize: vi.fn((source: { size?: number }) => source.size),
  prepareInputAssets: vi.fn(),
  prepareMultipleDirectInputAssets: vi.fn(),
}));

vi.mock("../../src/lib/input/input-preparation-service.ts", () => prep);

type State = SharedRomSourceState;
const makeAsset = (fileName: string, size = 10, extras: Partial<InputAsset> = {}): InputAsset => ({
  file: { _cleanup: vi.fn(async () => undefined), fileName, fileSize: size } as never,
  fileName,
  id: `asset-${fileName}`,
  kind: "rom",
  patchable: true,
  size,
  ...extras,
});

const makeController = (options: Partial<ConstructorParameters<typeof StagedRomSourceController<State>>[0]> = {}) => {
  const releaseSources = vi.fn(async () => undefined);
  const emitProgress = vi.fn();
  const trace = vi.fn();
  const controller = new StagedRomSourceController<{ name: string; size?: number }, State>({
    emitProgress,
    getExecutionOptions: () => ({ workers: { threads: 2 } }),
    getSourceId: (role, index) => `${role}-${index}`,
    id: "deep",
    runtime: { name: "browser", noteIoBatch: vi.fn(), workerIo: { releaseSources } } as never,
    trace,
    workflow: "apply",
    ...options,
  });
  return { controller, emitProgress, releaseSources, trace };
};

beforeEach(() => {
  prep.getBinarySourceSize.mockClear();
  prep.prepareInputAssets.mockReset();
  prep.prepareMultipleDirectInputAssets.mockReset();
});

describe("StagedRomSourceController stage construction", () => {
  it("creates a source with a normalized file name, size, and stable id", () => {
    const { controller } = makeController();
    const stage = controller.createInitialSource("input", { name: "/drop/game.bin", size: 25 }, 1);
    expect(stage.state).toMatchObject({
      fileName: "game.bin",
      id: "input-1",
      order: 1,
      role: "input",
      size: 25,
      sourceSize: 25,
      status: "loading",
    });
    expect(stage.internalCandidates).toEqual(new Map());
    expect(controller.createInitialSource("input", { name: "game.bin" }, 0, { id: "explicit" }).state.id).toBe(
      "explicit",
    );
  });

  it("clones selection candidates and warning text for a request", () => {
    const { controller } = makeController();
    const state = controller.createInitialSource("input", { name: "game.bin" }, 0).state;
    const candidate = {
      breadcrumbs: ["archive.zip"],
      fileName: "game.bin",
      id: "candidate",
      kind: "rom",
      patchable: true,
      selectable: true,
      size: 3,
      type: "file",
    } as never;
    state.candidates = [candidate];
    state.warnings = [{ message: "choose a ROM", role: "input" }];
    const request = controller.createSelectionRequest(state);
    expect(request).toEqual({
      candidates: [candidate],
      role: "input",
      sourceName: "game.bin",
      warnings: ["choose a ROM"],
    });
    expect(request.candidates[0]).not.toBe(candidate);
    expect((request.candidates[0] as never as { breadcrumbs: string[] }).breadcrumbs).not.toBe(candidate.breadcrumbs);
  });

  it("stages one prepared asset, emits preparation progress, and auto-selects it", async () => {
    const asset = makeAsset("game.bin", 99, {
      preparation: {
        decompressionTimeMs: 4,
        parentCompressions: [{ depth: 0, fileName: "game.zip", kind: "zip", outputSize: 99, sourceSize: 200 }],
        sourceSize: 200,
        wasDecompressed: true,
      },
    });
    prep.prepareInputAssets.mockImplementation(async (_source, options) => {
      options.onProgress({
        current: 1,
        details: { nested: true },
        hasProgress: true,
        label: "Extracting game.zip",
        percent: 50,
        total: 2,
      });
      return [asset];
    });
    const { controller, emitProgress, trace } = makeController();
    const stage = await controller.stageSource(
      controller.createInitialSource("input", { name: "game.zip", size: 200 }, 0),
    );

    expect(stage.state.status).toBe("ready");
    expect(stage.state.selectedCandidateId).toMatch(/^deep:input:1$/);
    expect(stage.state.fileName).toBe("game.bin");
    expect(stage.state.size).toBe(99);
    expect(stage.state.sourceSize).toBe(200);
    expect(stage.state.wasDecompressed).toBe(true);
    expect(stage.state.decompressionTimeMs).toBe(4);
    expect(stage.state.parentCompressions).toEqual(asset.preparation?.parentCompressions);
    expect(emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "decompress", percent: 50, role: "input" }),
    );
    expect(trace).toHaveBeenCalledWith("source.stage.start", expect.any(Object));
    expect(trace).toHaveBeenCalledWith("source.stage.finish", expect.objectContaining({ status: "ready" }));
  });

  it("keeps multiple prepared ROM candidates pending until the selected candidate is prepared", async () => {
    const first = makeAsset("first.bin", 10);
    const second = makeAsset("second.bin", 20);
    prep.prepareInputAssets.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([second]);
    const selection = vi.fn(async ({ candidates }: { candidates: Array<{ id: string }> }) => ({
      id: candidates[1]?.id,
    }));
    const { controller } = makeController({ selectFile: selection });
    const stage = await controller.stageSource(controller.createInitialSource("input", { name: "bundle.zip" }, 0));

    expect(stage.state.status).toBe("needsSelection");
    expect(stage.state.candidates).toHaveLength(2);
    expect(selection).not.toHaveBeenCalled();
    expect(await controller.maybeResolveBlockingStageSelection(stage)).toBe(true);
    expect(selection).toHaveBeenCalledTimes(1);
    expect(stage.state.status).toBe("ready");
    expect(stage.state.fileName).toBe("second.bin");
    expect(stage.selectedArchiveEntry).toBe("second.bin");
  });

  it("maps grouped candidates and leaves a stage pending when preparation yields ambiguity", async () => {
    const request = {
      candidates: [
        {
          candidateIds: ["rom", "track"],
          id: "disc",
          kind: "cue-disc",
          label: "disc.cue",
          patchable: true,
          selectable: true,
          type: "group",
          warnings: [],
        },
        { fileName: "rom.bin", id: "rom", kind: "rom", patchable: true, selectable: true, type: "file" },
        {
          fileName: "track.bin",
          id: "track",
          kind: "track",
          parentCandidateId: "disc",
          patchable: false,
          selectable: false,
          type: "file",
        },
      ],
      role: "input",
      sourceName: "disc.cue",
      warnings: [],
    } as never;
    prep.prepareInputAssets.mockImplementationOnce(async (_source, options) => {
      options.onCandidatesFound(request);
      return [];
    });
    const { controller } = makeController();
    const stage = await controller.stageSource(controller.createInitialSource("input", { name: "disc.cue" }, 0));
    expect(stage.state.status).toBe("needsSelection");
    const group = stage.state.candidates.find((candidate) => candidate.type === "group") as never as {
      candidateIds: string[];
      id: string;
    };
    expect(group.candidateIds).toHaveLength(2);
    expect(stage.internalCandidates.get(group.id)?.archiveEntry).toBe("disc.cue");
  });

  it("surfaces a warning when preparation fails without a candidate request", async () => {
    prep.prepareInputAssets
      .mockRejectedValueOnce(new Error("cannot read source"))
      .mockResolvedValueOnce([makeAsset("bad.bin")]);
    const { controller } = makeController();
    const stage = await controller.stageSource(controller.createInitialSource("input", { name: "bad.bin" }, 0));
    expect(stage.state.warnings).toEqual([expect.objectContaining({ message: "cannot read source", role: "input" })]);
    expect(stage.state.status).toBe("ready");
  });
});

describe("StagedRomSourceController sessions and metadata", () => {
  it("stages a single source session and rejects an empty source list", async () => {
    prep.prepareInputAssets.mockResolvedValue([makeAsset("game.bin", 4)]);
    const { controller } = makeController({ getSessionId: (role) => `${role}-session` });
    await expect(controller.stageSession("input", [])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const session = await controller.stageSession("input", [{ name: "game.bin", size: 4 }]);
    expect(session.synthetic).toBe(false);
    expect(session.stages).toHaveLength(1);
    expect(session.view.state.status).toBe("ready");
  });

  it("builds a direct multi-file cohesive disc view without prompting", async () => {
    const cue = makeAsset("disc.cue", 5, { kind: "cue", patchable: false, groupId: "disc" });
    const track = makeAsset("track.bin", 40, { kind: "track", groupId: "disc" });
    prep.prepareMultipleDirectInputAssets.mockResolvedValue([cue, track]);
    const selection = vi.fn();
    const { controller } = makeController({ getSessionId: (role) => `${role}-session`, selectFile: selection });
    const session = await controller.stageSession("input", [
      { name: "disc.cue", size: 5 },
      { name: "track.bin", size: 40 },
    ]);
    expect(session.synthetic).toBe(false);
    expect(session.view.state.status).toBe("ready");
    expect(session.view.state.selectedCandidateId).toBeDefined();
    expect(selection).not.toHaveBeenCalled();
    expect(session.view.state.size).toBe(45);
  });

  it("stages several sources independently and builds a synthetic session", async () => {
    prep.prepareMultipleDirectInputAssets.mockResolvedValue(undefined);
    prep.prepareInputAssets.mockImplementation(async (source: { name: string }) => [makeAsset(source.name)]);
    const { controller, releaseSources } = makeController({ getSessionId: (role) => `${role}-session` });
    const session = await controller.stageSession("input", [
      { name: "one.bin", size: 1 },
      { name: "two.bin", size: 2 },
    ]);
    expect(session.synthetic).toBe(true);
    expect(session.stages).toHaveLength(2);
    expect(session.view.state.id).toBe("input-session");
    expect(session.view.state.status).toBe("needsSelection");
    expect(session.view.state.sourceSize).toBe(3);
    expect(releaseSources).not.toHaveBeenCalled();
  });

  it("syncs a synthetic view from its selected owner and copies ROM identity fields", () => {
    const { controller } = makeController();
    const owner = controller.createInitialSource("input", { name: "game.bin", size: 10 }, 0);
    owner.state.status = "ready";
    owner.state.selectedCandidateId = "public-choice";
    owner.state.fileName = "selected.bin";
    owner.state.size = 10;
    owner.state.sourceSize = 20;
    owner.state.checksums = { crc32: "abc" };
    owner.state.identification = { title: "Selected" };
    owner.parentCompressions = [{ depth: 0, fileName: "archive.zip", kind: "zip" }];
    owner.state.parentCompressions = owner.parentCompressions;
    const view = controller.createInitialSource("input", { name: "view" }, 0, { id: "view" });
    view.internalCandidates.set("public-choice", { candidate: { id: "owner-choice", type: "file" } as never, owner });
    view.state.selectedCandidateId = "public-choice";
    const session: SharedRomSourceSession<{ name: string; size?: number }, State> = {
      role: "input",
      sources: [{ name: "game.bin", size: 20 }],
      stages: [owner],
      synthetic: true,
      view,
    };
    controller.syncSessionView(session);
    expect(view.state).toMatchObject({
      checksums: { crc32: "abc" },
      fileName: "selected.bin",
      identification: { title: "Selected" },
      size: 10,
      sourceSize: 20,
      status: "ready",
    });
    expect(view.parentCompressions).toEqual(owner.parentCompressions);
    expect(controller.getSelectedOwner(session)).toBe(owner);
    expect(controller.getSelectedOwner(undefined)).toBeUndefined();
  });

  it("releases prepared files and runtime sources for a session", async () => {
    const cleanup = vi.fn(async () => undefined);
    const prepared = makeAsset("prepared.bin");
    prepared.file._cleanup = cleanup;
    const { controller, releaseSources } = makeController();
    const stage = controller.createInitialSource("input", { name: "source.bin" }, 0);
    stage.preparedInputAssets = [prepared];
    const session = {
      role: "input",
      sources: [{ name: "source.bin" }],
      stages: [stage],
      synthetic: false,
      view: stage,
    } as SharedRomSourceSession<{ name: string }, State>;
    await controller.releaseSession(session);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(releaseSources).toHaveBeenCalledWith(expect.arrayContaining([prepared.file, session.sources[0]]));
    await controller.releaseSession(undefined);
    expect(releaseSources).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown candidate and resets identity when returning to selection", () => {
    const { controller } = makeController();
    const stage = controller.createInitialSource("input", { name: "game.bin" }, 0);
    expect(() => controller.setSelectedCandidate(stage, "missing")).toThrow("Selection candidate was not found");
    stage.state.status = "ready";
    stage.state.selectedCandidateId = "picked";
    stage.state.checksums = { crc32: "bad" };
    stage.state.identification = { title: "old" };
    stage.state.parentCompressions = [{ depth: 0, fileName: "x", kind: "zip" }];
    controller.resetStageForSelection(stage);
    expect(stage.state).toMatchObject({
      checksums: undefined,
      identification: undefined,
      selectedCandidateId: undefined,
      status: "needsSelection",
    });
    expect(stage.parentCompressions).toEqual([]);
  });
});
