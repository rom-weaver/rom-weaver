import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type Source = { name: string };
type Probe = {
  addCandidateRequest: (...args: unknown[]) => void;
  addDirectCandidate: (...args: unknown[]) => void;
  addFannedOutPatch: (...args: unknown[]) => Promise<void>;
  applyEarlySidecarSelection: (...args: unknown[]) => Promise<boolean>;
  createExecutionOptions: (...args: unknown[]) => Record<string, unknown>;
  createInitialSource: (role: "input" | "patch", source: Source, index: number) => Stage;
  createPatchInput: (...args: unknown[]) => Record<string, unknown>;
  emitApplyWorkerProgress: (progress: Record<string, unknown>) => void;
  emitProgress: (event: Record<string, unknown>) => void;
  emitChange: () => void;
  finalizeInputStableState: () => Promise<boolean>;
  flushPendingOwnedSourceReleases: () => Promise<void>;
  getBundleExportSources: () => Record<string, unknown>;
  getEffectiveInputSources: () => Source[];
  getInput: () => Record<string, unknown> | null;
  getPatchSources: () => Source[];
  getPatches: () => Record<string, unknown>[];
  getPreparedInputAssets: () => unknown[];
  handleSourceSelectionRequests: (stage: Stage, requests: unknown[]) => void;
  inputSession?: Session;
  maybeResolveBlockingInputSelection: () => Promise<boolean>;
  maybeResolveBlockingPatchSelection: (...args: unknown[]) => Promise<boolean>;
  outputState: Record<string, unknown>;
  patches: Stage[];
  parsePatch: (stage: Stage) => Promise<void>;
  recomputeOutputState: () => void;
  refreshPatchReadiness: () => Promise<void>;
  releaseOwnedSources: (sources: unknown[]) => Promise<void>;
  releasePatchSources: () => Promise<void>;
  releaseRuntimeSources: (sources: unknown[]) => Promise<void>;
  retainOwnedSources: (sources: unknown[]) => void;
  resolvePatchSelectionChoice: (stage: Stage) => Promise<boolean>;
  runParsePatch: (stage: Stage) => Promise<void>;
  run: () => Promise<unknown>;
  selectFile?: unknown;
  setInput: (...args: unknown[]) => Promise<void>;
  stageInputSession: (sources: Source[]) => Promise<Session>;
  stageSource: (stage: Stage, options?: Record<string, unknown>) => Promise<Stage>;
  syncInputSessionView: () => void;
  validatePatches: (options?: Record<string, unknown>) => Promise<void>;
};
type Stage = {
  source: Source;
  index: number;
  parentCompressions: unknown[];
  internalCandidates: Map<string, unknown>;
  preparedInputAssets?: unknown[];
  preparedPatchFile?: Record<string, unknown>;
  parsedPatch?: unknown;
  pendingSelectedIds?: string[];
  selectedArchiveEntry?: string;
  state: Record<string, unknown> & { candidates: unknown[] };
};
type Session = {
  role: "input";
  sources: Source[];
  stages: Stage[];
  synthetic: boolean;
  view: Stage;
};

const source = (name: string): Source => ({ name });
const patchFile = (fileName: string, fileSize = 4) => ({
  _sourceRef: { fileName, size: fileSize, source: `/work/${fileName}` },
  _u8array: new Uint8Array(fileSize),
  fileName,
  fileSize,
});
const candidate = (id: string, fileName: string, kind: "rom" | "patch" = "rom") => ({
  fileName,
  id,
  kind,
  patchable: true,
  selectable: true,
  size: 8,
  type: "file",
  candidateIds: [],
  warnings: [],
});

const makeController = (options: Record<string, unknown> = {}) =>
  new ApplyWorkflowController<Source, unknown>(
    {
      name: "browser",
      workerIo: {
        releaseOwnedSources: vi.fn(async () => undefined),
        releaseSources: vi.fn(async () => undefined),
        retainOwnedSources: vi.fn(),
      },
    } as never,
    options as never,
  ) as unknown as Probe;

const inputStage = (controller: Probe, name: string, status = "ready") => {
  const stage = controller.createInitialSource("input", source(name), 0);
  stage.state.status = status;
  stage.state.candidates = [candidate("input-choice", name)];
  stage.state.selectedCandidateId = status === "ready" ? "input-choice" : undefined;
  return stage;
};

const patchStage = (controller: Probe, name: string, status = "ready") => {
  const stage = controller.createInitialSource("patch", source(name), 0);
  stage.state.status = status;
  stage.state.candidates = [candidate("patch-choice", name, "patch")];
  stage.state.selectedCandidateId = status === "ready" ? "patch-choice" : undefined;
  stage.preparedPatchFile = patchFile(name);
  stage.parsedPatch = { format: "ips", requirements: {} };
  return stage;
};

afterEach(() => vi.useRealTimers());

describe("apply controller snapshots and execution inputs", () => {
  it("reports immutable empty and ready snapshots", () => {
    const controller = makeController({ settings: { output: { outputName: "out.sfc" } } });
    const empty = (controller as unknown as { getSnapshot: () => Record<string, unknown> }).getSnapshot();
    expect(empty).toMatchObject({ input: null, patches: [], ready: false });
    expect((controller as unknown as { getSnapshot: () => unknown }).getSnapshot()).toBe(empty);

    const stage = inputStage(controller, "rom.sfc");
    stage.preparedInputAssets = [
      {
        file: patchFile("rom.sfc", 8),
        fileName: "rom.sfc",
        id: "input-choice",
        kind: "rom",
        patchable: true,
        size: 8,
      },
    ];
    controller.inputSession = {
      role: "input",
      sources: [source("rom.sfc")],
      stages: [stage],
      synthetic: false,
      view: stage,
    };
    controller.patches = [patchStage(controller, "update.ips")];
    controller.emitChange();
    const readySnapshot = (controller as unknown as { getSnapshot: () => Record<string, unknown> }).getSnapshot();
    expect(readySnapshot).toMatchObject({
      ready: true,
      input: { fileName: "rom.sfc" },
      patches: [{ fileName: "update.ips", status: "ready" }],
    });
    expect(readySnapshot).not.toBe(empty);
  });

  it("exports selected input and patch sources with external file metadata", () => {
    const controller = makeController();
    const input = inputStage(controller, "rom.sfc");
    input.state.checksums = { crc32: "a1b2c3d4" };
    input.state.romType = { recommendedFormat: "sfc" };
    input.preparedInputAssets = [
      {
        file: patchFile("rom.sfc", 8),
        fileName: "rom.sfc",
        id: "input-choice",
        kind: "rom",
        patchable: true,
        size: 8,
      },
    ];
    controller.inputSession = {
      role: "input",
      sources: [source("archive.zip")],
      stages: [input],
      synthetic: false,
      view: input,
    };
    const patch = patchStage(controller, "update.ips");
    patch.preparedPatchFile = patchFile("prepared.ips", 5);
    controller.patches = [patch];

    expect(controller.getInput()).toMatchObject({
      checksums: { crc32: "a1b2c3d4" },
      selectedCandidateId: "input-choice",
    });
    expect(controller.getPatchSources()).toEqual([source("update.ips")]);
    expect(controller.getBundleExportSources()).toMatchObject({
      rom: {
        fileName: "rom.sfc",
        originalSource: source("rom.sfc"),
        size: 8,
        source: { fileName: "rom.sfc", size: 8, source: "/work/rom.sfc" },
        recommendedFormat: "sfc",
      },
      patches: [
        { fileName: "prepared.ips", size: 5, source: { fileName: "prepared.ips", source: "/work/prepared.ips" } },
      ],
    });
  });

  it("uses only the selected owner for a synthetic input session", () => {
    const controller = makeController();
    const first = inputStage(controller, "first.sfc");
    const second = inputStage(controller, "second.sfc");
    second.state.selectedCandidateId = "second-choice";
    second.state.candidates = [candidate("second-choice", "second.sfc")];
    const view = inputStage(controller, "synthetic.sfc");
    view.state.selectedCandidateId = "owner-choice";
    view.internalCandidates.set("owner-choice", { owner: second });
    controller.inputSession = {
      role: "input",
      sources: [first.source, second.source],
      stages: [first, second],
      synthetic: true,
      view,
    };
    expect(controller.getEffectiveInputSources()).toEqual([second.source]);
    expect(controller.getPreparedInputAssets()).toEqual([]);
    expect(controller.getInput()).toMatchObject({ selectedCandidateId: "owner-choice" });
  });
});

describe("apply controller source and option mutations", () => {
  it("sets every patch option, trims checksums, and skips readiness on a no-op", async () => {
    const controller = makeController();
    const stage = patchStage(controller, "patch.ips");
    controller.patches = [stage];
    const evaluate = vi.fn(async () => true);
    (controller as unknown as { evaluatePatchReadiness: typeof evaluate }).evaluatePatchReadiness = evaluate;

    await (
      controller as unknown as { setPatchOption: (index: number, option: Record<string, unknown>) => Promise<void> }
    ).setPatchOption(0, {
      basis: "previous",
      header: "strip",
      n64ByteOrder: "little-endian",
      validateInputChecksum: " 0102 ",
      validateOutputChecksum: " 0304 ",
    });
    expect(stage.state).toMatchObject({
      basisChoice: "previous",
      headerChoice: "strip",
      n64ByteOrderChoice: "little-endian",
      validateInputChecksum: "0102",
      validateOutputChecksum: "0304",
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await (
      controller as unknown as { setPatchOption: (index: number, option: Record<string, unknown>) => Promise<void> }
    ).setPatchOption(0, {
      basis: "previous",
      header: "strip",
      n64ByteOrder: "little-endian",
      validateInputChecksum: "0102",
      validateOutputChecksum: "0304",
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("builds execution and patch inputs from cloned settings and resolved options", () => {
    const controller = makeController({
      retainUncompressedOutput: "keep",
      settings: {
        input: { containerInputsEnabled: true },
        logging: { level: "debug", sink: vi.fn() },
        output: { outputName: "patched.sfc", compression: "zip", container: { profile: "fast" } },
        validation: { mode: "strict" },
        workers: { threads: 2 },
      },
    });
    const input = inputStage(controller, "rom.sfc");
    input.preparedInputAssets = [];
    controller.inputSession = {
      role: "input",
      sources: [input.source],
      stages: [input],
      synthetic: false,
      view: input,
    };
    const stage = patchStage(controller, "update.ips");
    stage.state.basisChoice = "base";
    stage.state.headerResolution = { decided: true, mode: "keep" };
    stage.state.n64Resolution = { decided: true, mode: "big-endian" };
    stage.state.targetInputId = "input-choice";
    stage.state.validateInputChecksum = "a";
    stage.state.validateOutputChecksum = "b";
    controller.patches = [stage];
    controller.outputState.outputFormat = "zip";
    controller.outputState.outputName = "patched.sfc";

    const onProgress = vi.fn();
    const execution = controller.createExecutionOptions(onProgress);
    expect(execution).toMatchObject({
      input: { containerInputsEnabled: true },
      logging: { level: "debug" },
      output: { compression: "zip", outputName: "patched.sfc" },
      retainUncompressedOutput: "keep",
      validation: { mode: "strict" },
      workers: { threads: 2 },
    });
    expect(execution.output).not.toBe((controller as unknown as { settings: Record<string, unknown> }).settings.output);

    const patchInput = controller.createPatchInput(onProgress);
    expect(patchInput).toMatchObject({
      options: execution,
      patches: [stage.source],
      patchOptions: [
        {
          basis: "base",
          header: "keep",
          n64ByteOrder: undefined,
          resolvedN64ByteOrder: "big-endian",
          validateInputChecksum: "a",
          validateOutputChecksum: "b",
        },
      ],
      patchTargets: ["input-choice"],
      parsedPatches: [stage.parsedPatch],
      preparedPatchFiles: [stage.preparedPatchFile],
    });
  });

  it("maps apply worker progress to workflow progress with safe defaults", () => {
    const controller = makeController();
    const events: Record<string, unknown>[] = [];
    controller.on("progress", (event) => events.push(event as unknown as Record<string, unknown>));
    controller.emitApplyWorkerProgress({
      stage: "output",
      details: { runtimeStage: "write" },
      hasProgress: true,
      label: "",
      percent: Number.NaN,
    });
    controller.emitApplyWorkerProgress({
      stage: "apply",
      details: null,
      hasProgress: false,
      label: "Applying",
      percent: 20,
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      label: "Compressing output...",
      role: "output",
      stage: "compress",
      percent: null,
      details: { runtimeStage: "write" },
    });
    expect(events[1]).toMatchObject({ label: "Applying", role: "worker", stage: "apply", percent: 20, details: {} });
  });
});

describe("apply controller selection and staging internals", () => {
  it("maps candidate requests to stable public ids and preserves group links", () => {
    const controller = makeController();
    const stage = controller.createInitialSource("patch", source("bundle.zip"), 0);
    controller.addCandidateRequest(stage, {
      candidates: [
        {
          candidateIds: ["leaf-a", "leaf-b"],
          fileName: "bundle",
          id: "group",
          kind: "patch",
          patchable: true,
          selectable: true,
          type: "group",
          warnings: [],
        },
        {
          fileName: "a.ips",
          id: "leaf-a",
          kind: "patch",
          patchable: true,
          selectable: true,
          type: "file",
          warnings: [],
        },
        {
          fileName: "b.ips",
          id: "leaf-b",
          kind: "patch",
          patchable: true,
          selectable: true,
          type: "file",
          parentCandidateId: "group",
          warnings: [],
        },
      ],
      multiSelect: true,
      role: "patch",
      sourceName: "bundle.zip",
      warnings: ["choose patches"],
    });
    expect(stage.state.multiSelect).toBe(true);
    expect(stage.state.candidates).toHaveLength(3);
    expect(stage.state.candidates[0]).toMatchObject({
      type: "group",
      candidateIds: expect.arrayContaining([expect.stringContaining(":patch:")]),
    });
    expect(stage.state.candidates[2]).toMatchObject({ parentCandidateId: expect.stringContaining(":patch:") });
    expect(stage.internalCandidates.size).toBe(3);
  });

  it("resolves a multi-select choice, rejects unknown ids, and applies valid picks", async () => {
    const selected = vi.fn(async () => ({ id: "public-a", ids: ["public-a", "public-b"] }));
    const controller = makeController({ selectFile: selected });
    const stage = controller.createInitialSource("patch", source("bundle.zip"), 0);
    stage.state.status = "needsSelection";
    stage.state.candidates = [candidate("public-a", "a.ips", "patch"), candidate("public-b", "b.ips", "patch")];
    stage.internalCandidates.set("public-a", { candidate: { id: "a", fileName: "a.ips", type: "file" }, owner: stage });
    stage.internalCandidates.set("public-b", { candidate: { id: "b", fileName: "b.ips", type: "file" }, owner: stage });
    expect(await controller.resolvePatchSelectionChoice(stage)).toBe(true);
    expect(stage.pendingSelectedIds).toEqual(["public-a", "public-b"]);

    const invalid = controller.createInitialSource("patch", source("bad.zip"), 0);
    invalid.state.status = "needsSelection";
    invalid.state.candidates = [candidate("public-a", "a.ips", "patch"), candidate("other", "other.ips", "patch")];
    invalid.internalCandidates.set("public-a", {
      candidate: { id: "a", fileName: "a.ips", type: "file" },
      owner: invalid,
    });
    selected.mockResolvedValueOnce({ id: "missing", ids: ["missing"] });
    await expect(controller.resolvePatchSelectionChoice(invalid)).rejects.toThrow(
      "Selection candidate was not found: missing",
    );
  });

  it("applies early manifest picks once, including duplicate leaves in pick order", async () => {
    const selectFile = vi.fn(async () => ({ id: "b.ips", ids: ["b.ips", "a.ips", "a.ips"] }));
    const controller = makeController({ selectFile });
    const stage = controller.createInitialSource("input", source("rom.zip"), 0);
    stage.state.id = "input-1";
    const add = vi.fn(async () => undefined);
    controller.addFannedOutPatch = add;
    controller.emitProgress({
      details: {
        patch_manifest: { patches: [{ file_name: "a.ips" }, { file_name: "b.ips" }, { file_name: "a.ips" }] },
        sourceId: "input-1",
      },
      hasProgress: true,
      id: "manifest",
      label: "manifest",
      percent: null,
      role: "input",
      stage: "input",
    });
    const sidecars = [
      { file: patchFile("a.ips"), parentCompressions: [] },
      { file: patchFile("b.ips"), parentCompressions: [] },
      { file: patchFile("a.ips"), parentCompressions: [] },
    ];
    expect(await controller.applyEarlySidecarSelection(stage, sidecars)).toBe(true);
    expect(add.mock.calls.map((call) => (call[0] as { fileName: string }).fileName)).toEqual([
      "b.ips",
      "a.ips",
      "a.ips",
    ]);
    expect(selectFile).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(3);
  });
});

describe("apply controller ownership and lifecycle", () => {
  it("coalesces ownership releases and reacquires after a flushed release", async () => {
    vi.useFakeTimers();
    const workerIo = {
      releaseOwnedSources: vi.fn(async () => undefined),
      retainOwnedSources: vi.fn(),
    };
    const controller = new ApplyWorkflowController<Source, unknown>({
      name: "browser",
      workerIo,
    } as never) as unknown as Probe;
    const shared = source("shared.zip");
    controller.retainOwnedSources([shared, shared]);
    await controller.releaseOwnedSources([shared]);
    await vi.runAllTimersAsync();
    expect(workerIo.releaseOwnedSources).not.toHaveBeenCalled();
    await controller.releaseOwnedSources([shared]);
    await controller.flushPendingOwnedSourceReleases();
    expect(workerIo.releaseOwnedSources).toHaveBeenCalledWith([shared]);
    controller.retainOwnedSources([shared]);
    expect(workerIo.retainOwnedSources).toHaveBeenCalledWith([shared]);
  });

  it("runs setInput callbacks after staging and releases sources on failure", async () => {
    const controller = makeController();
    const stage = inputStage(controller, "rom.sfc");
    controller.stageInputSession = vi.fn(async () => ({
      role: "input",
      sources: [source("rom.sfc")],
      stages: [stage],
      synthetic: false,
      view: stage,
    }));
    controller.maybeResolveBlockingInputSelection = vi.fn(async () => false);
    controller.finalizeInputStableState = vi.fn(async () => true);
    const discover = vi.fn(async () => undefined);
    (controller as unknown as { discoverImplicitPatches: typeof discover }).discoverImplicitPatches = discover;
    const refresh = vi.fn(async () => undefined);
    (controller as unknown as { refreshPatchReadiness: typeof refresh }).refreshPatchReadiness = refresh;
    const recompute = vi.fn();
    controller.recomputeOutputState = recompute;
    const prepared = vi.fn();
    const finalized = vi.fn();
    await controller.setInput(source("rom.sfc"), { onPrepared: prepared, onFinalized: finalized });
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ fileName: "rom.sfc" }));
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({ fileName: "rom.sfc" }));
    expect(discover).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect(recompute).toHaveBeenCalled();

    const failing = makeController();
    failing.stageInputSession = vi.fn(async () => {
      throw new Error("cannot stage input");
    });
    await expect(failing.setInput(source("broken.zip"))).rejects.toThrow("cannot stage input");
    expect(failing.getInput()).toBeNull();
  });

  it("parses a prepared patch once and marks missing or invalid files clearly", async () => {
    const controller = makeController();
    const missing = patchStage(controller, "missing.ips");
    missing.preparedPatchFile = undefined;
    await controller.runParsePatch(missing);
    expect(missing.state.status).toBe("needsSelection");

    const invalid = patchStage(controller, "invalid.ips");
    invalid.preparedPatchFile = { ...patchFile("invalid.ips"), readString: () => "", seek: () => undefined };
    await expect(controller.runParsePatch(invalid)).rejects.toThrow("Invalid patch file: invalid.ips");
  });

  it("rejects missing, ambiguous, and incomplete input before invoking the worker", async () => {
    const missing = makeController();
    await expect(missing.run()).rejects.toThrow("Input source is required");

    const ambiguous = makeController();
    const input = inputStage(ambiguous, "rom.sfc");
    input.state.status = "loading";
    input.state.selectedCandidateId = undefined;
    ambiguous.inputSession = { stages: [input], sources: [input.source], synthetic: false, view: input };
    ambiguous.finalizeInputStableState = vi.fn(async () => false);
    ambiguous.refreshPatchReadiness = vi.fn(async () => undefined);
    ambiguous.recomputeOutputState = vi.fn();
    await expect(ambiguous.run()).rejects.toThrow("Input selection is required");

    const pending = makeController();
    const readyInput = inputStage(pending, "rom.sfc");
    const patch = patchStage(pending, "a.ips") as Stage & { state: Record<string, unknown> };
    patch.state.selectedCandidateId = undefined;
    patch.state.status = "needsSelection";
    pending.inputSession = { stages: [readyInput], sources: [readyInput.source], synthetic: false, view: readyInput };
    pending.patches = [patch];
    pending.finalizeInputStableState = vi.fn(async () => false);
    pending.refreshPatchReadiness = vi.fn(async () => undefined);
    pending.recomputeOutputState = vi.fn();
    await expect(pending.run()).rejects.toThrow("a.ips requires selection");
  });

  it("rejects failed patches with their warning and missing output names", async () => {
    const controller = makeController();
    const input = inputStage(controller, "rom.sfc");
    const patch = patchStage(controller, "a.ips") as Stage & { state: Record<string, unknown> };
    patch.state.status = "failed";
    patch.state.selectedCandidateId = "patch-choice";
    patch.state.warnings = [{ message: "patch checksum failed" }];
    controller.inputSession = { stages: [input], sources: [input.source], synthetic: false, view: input };
    controller.patches = [patch];
    controller.finalizeInputStableState = vi.fn(async () => false);
    controller.refreshPatchReadiness = vi.fn(async () => undefined);
    controller.recomputeOutputState = vi.fn();
    await expect(controller.run()).rejects.toThrow("patch checksum failed");

    const noName = makeController();
    noName.inputSession = { stages: [input], sources: [input.source], synthetic: false, view: input };
    noName.finalizeInputStableState = vi.fn(async () => false);
    noName.refreshPatchReadiness = vi.fn(async () => undefined);
    noName.recomputeOutputState = vi.fn();
    noName.outputState.outputName = "";
    await expect(noName.run()).rejects.toThrow("Output name is required");
  });

  it("adds a staged patch and clears a staged input session", async () => {
    const controller = makeController();
    controller.recomputeOutputState = vi.fn();
    controller.stageSource = vi.fn(async (stage: Stage) => {
      stage.state.status = "ready";
      stage.state.selectedCandidateId = "patch-choice";
      return stage;
    });
    controller.maybeResolveBlockingPatchSelection = vi.fn(async () => false);
    controller.evaluatePatchReadiness = vi.fn(async () => true);
    await (controller as unknown as { addPatch: (patch: Source) => Promise<void> }).addPatch({ name: "new.ips" });
    expect(controller.patches).toHaveLength(1);
    expect(controller.patches[0]?.state.status).toBe("ready");
    expect(controller.recomputeOutputState).toHaveBeenCalled();

    const input = inputStage(controller, "rom.sfc");
    controller.inputSession = { stages: [input], sources: [input.source], synthetic: false, view: input };
    controller.retainOwnedSources([input.source]);
    controller.refreshPatchReadiness = vi.fn(async () => undefined);
    await (controller as unknown as { clearInput: () => Promise<void> }).clearInput();
    expect(controller.inputSession).toBeUndefined();
    expect(controller.refreshPatchReadiness).toHaveBeenCalled();
  });
});
