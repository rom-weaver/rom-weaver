import { describe, expect, it, vi } from "vitest";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type Source = { name: string };

type SidecarLeaf = { file: { fileName: string }; parentCompressions: string[]; sidecarOrder?: number };

type StageProbe = {
  outputLabel?: string;
  source: Source;
  state: { fileName: string; id: string; role: string; status: string };
};

type ControllerProbe = {
  addFannedOutPatch: unknown;
  applyEarlySidecarSelection: unknown;
  clearPatches: () => Promise<void>;
  discoverImplicitPatches: () => Promise<void>;
  discoverNameMatchedSidecarPatches: (stages: unknown[]) => Promise<void>;
  evaluatePatchReadiness: unknown;
  getPatchableInputAssets: unknown;
  inputSession?: unknown;
  maybeResolveBlockingPatchSelection: unknown;
  outputState: Record<string, unknown>;
  patches: StageProbe[];
  preloadRuntimeCapability: unknown;
  addCandidateRequest: unknown;
  createInitialSource: (role: string, source: Source, index: number) => StageProbe;
  handleSourceSelectionRequests: (stage: unknown, requests: unknown[]) => void;
  recomputeOutputState: unknown;
  replacePatchAt: (index: number, patch: Source) => Promise<void>;
  resolvePatchSelectionChoice: unknown;
  runParsePatch: (stage: unknown) => Promise<void>;
  refreshPatchReadiness: unknown;
  releaseOwnedSources: unknown;
  releasePatchSources: unknown;
  releaseRuntimeSources: unknown;
  retainOwnedSources: unknown;
  selectFile?: unknown;
  setOutputFormat: (format: string) => Promise<void>;
  setOutputName: (name: string) => Promise<void>;
  setPatchTarget: (index: number, targetInputId: string) => Promise<void>;
  setSettings: (settings: Record<string, unknown>) => Promise<void>;
  settings: Record<string, unknown>;
  stageSidecarPatches: unknown;
  stageSource: unknown;
  surfaceArchivePatchSelection: unknown;
  trace: unknown;
};

const createController = () => {
  const controller = new ApplyWorkflowController<Source, unknown>(
    { workerIo: { releaseOwnedSources: vi.fn(async () => undefined) } } as never,
    {},
  ) as never as ControllerProbe;
  controller.addCandidateRequest = vi.fn();
  controller.addFannedOutPatch = vi.fn(async () => undefined);
  controller.resolvePatchSelectionChoice = vi.fn(async () => undefined);
  controller.evaluatePatchReadiness = vi.fn(async () => undefined);
  controller.maybeResolveBlockingPatchSelection = vi.fn(async () => undefined);
  controller.preloadRuntimeCapability = vi.fn();
  controller.recomputeOutputState = vi.fn();
  controller.refreshPatchReadiness = vi.fn(async () => undefined);
  controller.releaseOwnedSources = vi.fn(async () => undefined);
  controller.releasePatchSources = vi.fn(async () => undefined);
  controller.releaseRuntimeSources = vi.fn(async () => undefined);
  controller.retainOwnedSources = vi.fn();
  controller.stageSource = vi.fn(async (stage: unknown) => stage);
  return controller;
};

const leaf = (fileName: string, sidecarOrder?: number): SidecarLeaf => ({
  file: { fileName },
  parentCompressions: ["zip"],
  ...(sidecarOrder === undefined ? {} : { sidecarOrder }),
});

const inputStage = (id: string, fileName: string) => ({
  source: { name: fileName },
  state: { fileName, id, role: "input", status: "ready" },
});

describe("discoverImplicitPatches", () => {
  it("does nothing when patches are already staged or no input session exists", async () => {
    const controller = createController();
    controller.stageSidecarPatches = vi.fn(() => [leaf("a.ips")]);

    await controller.discoverImplicitPatches();
    expect(controller.stageSidecarPatches).not.toHaveBeenCalled();

    controller.patches = [
      { source: { name: "p.ips" }, state: { fileName: "p.ips", id: "p", role: "patch", status: "ready" } },
    ];
    controller.inputSession = { stages: [inputStage("in-1", "rom.sfc")], view: inputStage("in-1", "rom.sfc") };
    await controller.discoverImplicitPatches();
    expect(controller.stageSidecarPatches).not.toHaveBeenCalled();
  });

  it("falls back to the session view when no stages were recorded", async () => {
    const controller = createController();
    const view = inputStage("in-1", "rom.sfc");
    controller.inputSession = { stages: [], view };
    controller.selectFile = vi.fn();
    controller.stageSidecarPatches = vi.fn(() => []);

    await controller.discoverImplicitPatches();

    expect(controller.stageSidecarPatches).toHaveBeenCalledWith(view);
  });

  describe("without a selection handler", () => {
    it("adds every name-matched sidecar in its recorded order", async () => {
      const controller = createController();
      controller.inputSession = {
        stages: [inputStage("in-1", "rom.sfc"), inputStage("in-2", "rom2.sfc")],
        view: inputStage("in-1", "rom.sfc"),
      };
      controller.stageSidecarPatches = vi.fn((stage: { state: { id: string } }) =>
        stage.state.id === "in-1" ? [leaf("second.ips", 2), leaf("unordered.ips")] : [leaf("first.ips", 1)],
      );

      await controller.discoverImplicitPatches();

      expect(
        vi.mocked(controller.addFannedOutPatch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]),
      ).toEqual([{ fileName: "first.ips" }, { fileName: "second.ips" }]);
      expect(vi.mocked(controller.addFannedOutPatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual(["zip"]);
    });

    it("adds nothing when no sidecar carries an order", async () => {
      const controller = createController();
      controller.inputSession = { stages: [inputStage("in-1", "rom.sfc")], view: inputStage("in-1", "rom.sfc") };
      controller.stageSidecarPatches = vi.fn(() => [leaf("loose.ips")]);

      await controller.discoverNameMatchedSidecarPatches([inputStage("in-1", "rom.sfc")]);

      expect(controller.addFannedOutPatch).not.toHaveBeenCalled();
    });
  });

  describe("with a selection handler", () => {
    const withHandler = () => {
      const controller = createController();
      controller.selectFile = vi.fn();
      controller.inputSession = { stages: [inputStage("in-1", "rom.sfc")], view: inputStage("in-1", "rom.sfc") };
      controller.applyEarlySidecarSelection = vi.fn(async () => false);
      controller.surfaceArchivePatchSelection = vi.fn(async () => undefined);
      return controller;
    };

    it("skips a stage with no sidecars", async () => {
      const controller = withHandler();
      controller.stageSidecarPatches = vi.fn(() => []);

      await controller.discoverImplicitPatches();

      expect(controller.applyEarlySidecarSelection).not.toHaveBeenCalled();
      expect(controller.addFannedOutPatch).not.toHaveBeenCalled();
    });

    it("defers to an early sidecar pick when one already resolved", async () => {
      const controller = withHandler();
      controller.applyEarlySidecarSelection = vi.fn(async () => true);
      controller.stageSidecarPatches = vi.fn(() => [leaf("a.ips"), leaf("b.ips")]);

      await controller.discoverImplicitPatches();

      expect(controller.addFannedOutPatch).not.toHaveBeenCalled();
      expect(controller.surfaceArchivePatchSelection).not.toHaveBeenCalled();
    });

    it("auto-adds a lone sidecar without prompting", async () => {
      const controller = withHandler();
      controller.stageSidecarPatches = vi.fn(() => [leaf("only.ips")]);

      await controller.discoverImplicitPatches();

      expect(controller.addFannedOutPatch).toHaveBeenCalledWith({ fileName: "only.ips" }, ["zip"]);
      expect(controller.surfaceArchivePatchSelection).not.toHaveBeenCalled();
    });

    it("surfaces the archive for selection when several sidecars are present", async () => {
      const controller = withHandler();
      controller.stageSidecarPatches = vi.fn(() => [leaf("a.ips"), leaf("b.ips")]);

      await controller.discoverImplicitPatches();

      expect(controller.addFannedOutPatch).not.toHaveBeenCalled();
      expect(controller.surfaceArchivePatchSelection).toHaveBeenCalledWith({ name: "rom.sfc" });
    });
  });
});

describe("surfaceArchivePatchSelection", () => {
  it("stages the archive as a patch slot and evaluates it", async () => {
    const controller = createController();
    const source = { name: "bundle.zip" };

    await (controller.surfaceArchivePatchSelection as (patchSource: Source) => Promise<void>)(source);

    expect(controller.retainOwnedSources).toHaveBeenCalledWith([source]);
    expect(controller.patches).toHaveLength(1);
    expect(controller.patches[0]?.source).toBe(source);
    expect(controller.patches[0]?.state.role).toBe("patch");
    expect(controller.patches[0]?.state.fileName).toBe("bundle.zip");
    expect(controller.maybeResolveBlockingPatchSelection).toHaveBeenCalledTimes(1);
    expect(controller.evaluatePatchReadiness).toHaveBeenCalledTimes(1);
  });

  it("rolls the slot back and releases the source when staging fails", async () => {
    const controller = createController();
    controller.stageSource = vi.fn(async () => {
      throw new Error("staging failed");
    });
    const source = { name: "bundle.zip" };

    await (controller.surfaceArchivePatchSelection as (patchSource: Source) => Promise<void>)(source);

    expect(controller.patches).toEqual([]);
    expect(controller.releaseRuntimeSources).toHaveBeenCalledWith([source]);
    expect(controller.releaseOwnedSources).toHaveBeenCalledWith([source]);
  });
});

describe("clearPatches", () => {
  it("drops every patch slot and recomputes the output", async () => {
    const controller = createController();
    controller.patches = [
      { source: { name: "a.ips" }, state: { fileName: "a.ips", id: "a", role: "patch", status: "ready" } },
    ];

    await controller.clearPatches();

    expect(controller.releasePatchSources).toHaveBeenCalledTimes(1);
    expect(controller.patches).toEqual([]);
    expect(controller.recomputeOutputState).toHaveBeenCalled();
  });
});

describe("setSettings", () => {
  it("stores a deep copy and recomputes the output state", async () => {
    const controller = createController();
    const settings = { workers: { threads: "auto" } };

    await controller.setSettings(settings);

    expect(controller.settings).toEqual(settings);
    expect(controller.settings).not.toBe(settings);
    expect(controller.refreshPatchReadiness).toHaveBeenCalledTimes(1);
    expect(controller.recomputeOutputState).toHaveBeenCalled();
  });

  it("preloads the compression runtime only when the thread count changes", async () => {
    const controller = createController();

    await controller.setSettings({ workers: { threads: "auto" } });
    expect(controller.preloadRuntimeCapability).not.toHaveBeenCalled();

    await controller.setSettings({ workers: { threads: 4 } });
    expect(controller.preloadRuntimeCapability).toHaveBeenCalledWith("compression");
  });

  it("treats a missing settings object as empty", async () => {
    const controller = createController();

    await controller.setSettings(null as never);

    expect(controller.settings).toEqual({});
  });
});

describe("setOutputFormat", () => {
  it("rejects a format the app does not support", async () => {
    const controller = createController();

    await expect(controller.setOutputFormat("rar")).rejects.toThrow("Unsupported output format: rar");
  });

  it("accepts a supported format and recomputes the output", async () => {
    const controller = createController();

    await controller.setOutputFormat("zip");

    expect(controller.outputState.outputFormat).toBe("zip");
    expect(controller.recomputeOutputState).toHaveBeenCalled();
  });
});

describe("setOutputName", () => {
  it("stores the requested output name", async () => {
    const controller = createController();

    await controller.setOutputName("patched.sfc");

    expect(controller.outputState.outputName).toBe("patched.sfc");
  });
});

describe("setPatchTarget", () => {
  const patchStage = () => ({
    source: { name: "a.ips" },
    state: { fileName: "a.ips", id: "patch-a", role: "patch", status: "ready" },
  });

  it("rejects an index with no patch slot", async () => {
    const controller = createController();

    await expect(controller.setPatchTarget(2, "auto")).rejects.toThrow("Patch 3 was not found");
  });

  it("clears the target back to automatic", async () => {
    const controller = createController();
    const stage = patchStage() as StageProbe & { state: { targetInputId?: string } };
    stage.state.targetInputId = "input-1";
    controller.patches = [stage];

    await controller.setPatchTarget(0, "auto");

    expect(stage.state.targetInputId).toBeUndefined();
    expect(controller.evaluatePatchReadiness).toHaveBeenCalledWith(stage);
    expect(controller.recomputeOutputState).toHaveBeenCalled();
  });

  it("assigns a target found by id or by file name", async () => {
    const controller = createController();
    const stage = patchStage() as StageProbe & { state: { targetInputFileName?: string; targetInputId?: string } };
    controller.patches = [stage];
    controller.getPatchableInputAssets = vi.fn(() => [{ fileName: "rom.sfc", id: "input-1" }]);

    await controller.setPatchTarget(0, "input-1");
    expect(stage.state.targetInputId).toBe("input-1");

    stage.state.targetInputId = undefined;
    await controller.setPatchTarget(0, "rom.sfc");
    expect(stage.state.targetInputId).toBe("input-1");
  });

  it("rejects a target that no staged input matches", async () => {
    const controller = createController();
    controller.patches = [patchStage()];
    controller.getPatchableInputAssets = vi.fn(() => []);

    await expect(controller.setPatchTarget(0, "missing")).rejects.toThrow("Patch target was not found: missing");
  });
});

describe("replacePatchAt rollback", () => {
  it("restores the previous patch when staging the replacement fails", async () => {
    const controller = createController();
    const previous = controller.createInitialSource("patch", { name: "old.ips" }, 0);
    controller.patches = [previous];
    controller.stageSource = vi.fn(async () => {
      throw new Error("replacement staging failed");
    });

    await expect(controller.replacePatchAt(0, { name: "new.ips" })).rejects.toThrow("replacement staging failed");

    expect(controller.patches).toEqual([previous]);
    expect(controller.releaseRuntimeSources).toHaveBeenCalledWith([{ name: "new.ips" }]);
    expect(controller.releaseOwnedSources).toHaveBeenCalledWith([{ name: "new.ips" }]);
    expect(controller.recomputeOutputState).toHaveBeenCalled();
  });
});

describe("handleSourceSelectionRequests", () => {
  it("resets the stage to await a selection and forgets every derived verdict", () => {
    const controller = createController();
    const stage = controller.createInitialSource("patch", { name: "bundle.zip" }, 0) as StageProbe & {
      parentCompressions: string[];
      state: Record<string, unknown>;
    };
    stage.parentCompressions = ["zip"];
    Object.assign(stage.state, {
      checksumPreflight: { status: "ok" },
      checksumTimeMs: 12,
      checksumVariants: [{ crc32: "abc" }],
      checksums: { crc32: "abc" },
      decompressionTimeMs: 8,
      patchValidation: { status: "valid" },
      requirements: { targetSize: 4 },
      selectedCandidateId: "candidate-1",
      status: "ready",
      targetInputFileName: "rom.sfc",
      targetInputId: "input-1",
      wasDecompressed: true,
    });
    const requests = [{ candidates: [] }, { candidates: [] }];

    controller.handleSourceSelectionRequests(stage, requests);

    expect(controller.addCandidateRequest).toHaveBeenCalledTimes(2);
    expect(stage.state.candidates).toEqual([]);
    expect(stage.state.status).toBe("needsSelection");
    expect(stage.parentCompressions).toEqual([]);
    for (const key of [
      "checksumPreflight",
      "checksumTimeMs",
      "checksumVariants",
      "checksums",
      "decompressionTimeMs",
      "patchValidation",
      "requirements",
      "selectedCandidateId",
      "targetInputFileName",
      "targetInputId",
      "wasDecompressed",
    ]) {
      expect(stage.state[key]).toBeUndefined();
    }
  });
});

describe("runParsePatch", () => {
  it("sends a stage with no prepared patch file back for selection", async () => {
    const controller = createController();
    const stage = controller.createInitialSource("patch", { name: "a.ips" }, 0) as StageProbe & {
      state: Record<string, unknown>;
    };
    Object.assign(stage.state, {
      checksumPreflight: { status: "ok" },
      patchValidation: { status: "valid" },
      requirements: { targetSize: 4 },
      status: "ready",
    });

    await controller.runParsePatch(stage);

    expect(stage.state.status).toBe("needsSelection");
    expect(stage.state.requirements).toBeUndefined();
    expect(stage.state.checksumPreflight).toBeUndefined();
    expect(stage.state.patchValidation).toBeUndefined();
  });
});
