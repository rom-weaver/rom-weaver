import { describe, expect, it, vi } from "vitest";
import { CreateWorkflowController } from "../../src/lib/workflow/create-workflow-controller.ts";

type Source = { name: string };
type Stage = {
  source: Source;
  selectedArchiveEntry?: string;
  preparedInputAssets?: Array<Record<string, unknown>>;
  state: Record<string, unknown>;
};
type Session = { role: "original" | "modified"; sources: Source[]; stages: Stage[]; synthetic: boolean; view: Stage };
type Probe = {
  buildAutomaticOutputName: () => string;
  createExecutionOptions: () => Record<string, unknown>;
  createPatchInput: () => Record<string, unknown>;
  finalizeSourceStableState: (session: Session) => Promise<void>;
  getOutputCompression: () => string;
  getPatchType: () => string;
  modifiedSession?: Session;
  originalSession?: Session;
  outputName: string;
  patchType?: string;
  sourceStages: Record<string, (...args: unknown[]) => unknown>;
};

const source = (name: string): Source => ({ name });
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
const patchFile = (fileName: string) => ({
  _precomputedChecksumMs: 11,
  checksums: {
    crc32: "a1b2c3d4",
    md5: "00112233445566778899aabbccddeeff",
    sha1: "00112233445566778899aabbccddeeff00112233",
  },
  fileName,
  fileSize: 8,
  identification: { matches: [{ name: "Demo" }], status: "identified" },
  romType: { recommendedFormat: "sfc" },
});
const stage = (role: "original" | "modified", name: string, status = "ready"): Stage => ({
  source: source(name),
  state: {
    candidates: [candidate(`${role}-candidate`, name)],
    fileName: name,
    id: `${role}-1`,
    parentCompressions: [],
    role,
    selectedCandidateId: status === "ready" ? `${role}-candidate` : undefined,
    size: 8,
    sourceSize: 8,
    status,
    warnings: [],
  },
});
const session = (role: "original" | "modified", sourceStage: Stage): Session => ({
  role,
  sources: [sourceStage.source],
  stages: [sourceStage],
  synthetic: false,
  view: sourceStage,
});
const makeController = (settings: Record<string, unknown> = {}) =>
  new CreateWorkflowController<Source, unknown>({ name: "browser" }, { settings } as never) as unknown as Probe;

describe("create controller snapshots, naming, and settings", () => {
  it("clones source state into snapshots and computes readiness", async () => {
    const controller = makeController({ format: "bps" });
    const originalStage = stage("original", "old.sfc");
    const modifiedStage = stage("modified", "new.sfc");
    controller.originalSession = session("original", originalStage);
    controller.modifiedSession = session("modified", modifiedStage);
    controller.outputName = controller.buildAutomaticOutputName();
    const snapshot = (controller as unknown as { getSnapshot: () => Record<string, unknown> }).getSnapshot();
    expect(snapshot).toMatchObject({
      original: { fileName: "old.sfc", status: "ready" },
      modified: { fileName: "new.sfc", status: "ready" },
      outputName: "new.bps",
      patchType: "bps",
      ready: true,
    });
    expect((snapshot.original as Record<string, unknown>).candidates).not.toBe(originalStage.state.candidates);

    await controller.setPatchType("ips");
    expect((controller as unknown as { getSnapshot: () => Record<string, unknown> }).getSnapshot()).toMatchObject({
      patchType: "ips",
      outputName: "new.ips",
    });
    await controller.swap();
    expect(controller.originalSession?.view.state.fileName).toBe("new.sfc");
    expect(controller.outputName).toBe("old.ips");
    await (controller as unknown as { setOutputName: (name: string) => Promise<void> }).setOutputName("manual.ips");
    await controller.swap();
    expect(controller.outputName).toBe("manual.ips");
  });

  it("uses automatic names until a manual name is set, then preserves it", async () => {
    const controller = makeController({ output: { outputName: "configured.bps" }, format: "bps" });
    expect(controller.outputName).toBe("configured.bps");
    await (controller as unknown as { setOutputName: (name: string) => Promise<void> }).setOutputName("   ");
    expect(controller.outputName).toBe("configured.bps");
    await (controller as unknown as { setSettings: (settings: Record<string, unknown>) => Promise<void> }).setSettings({
      format: "ips",
    });
    expect(controller.getPatchType()).toBe("ips");
    expect(controller.outputName).toBe("configured.bps");
  });
});

describe("create controller execution input and checksums", () => {
  it("builds options and prepared source inputs with selected archive metadata", () => {
    const controller = makeController({
      format: "bps",
      input: { containerInputsEnabled: true },
      logging: { level: "debug", sink: vi.fn() },
      output: { compression: "zip" },
      patch: { metadata: { title: "demo" } },
      workers: { threads: 4 },
    });
    const originalStage = stage("original", "old.zip");
    const modifiedStage = stage("modified", "new.zip");
    originalStage.selectedArchiveEntry = "old.sfc";
    modifiedStage.selectedArchiveEntry = "new.sfc";
    originalStage.state.checksums = { crc32: "a1b2c3d4" };
    originalStage.preparedInputAssets = [
      { file: patchFile("old.sfc"), fileName: "old.sfc", id: "old", kind: "rom", patchable: true, size: 8 },
    ];
    modifiedStage.preparedInputAssets = [
      { file: patchFile("new.sfc"), fileName: "new.sfc", id: "new", kind: "rom", patchable: true, size: 8 },
    ];
    controller.originalSession = session("original", originalStage);
    controller.modifiedSession = session("modified", modifiedStage);
    controller.outputName = "new.bps";

    const options = controller.createExecutionOptions();
    expect(options).toMatchObject({
      format: "bps",
      input: { containerInputsEnabled: true },
      output: { compression: "zip", outputName: "new.bps" },
      patch: { metadata: { title: "demo" } },
      workers: { threads: 4 },
    });
    const input = controller.createPatchInput();
    expect(input).toMatchObject({
      original: originalStage.preparedInputAssets?.[0]?.file,
      modified: modifiedStage.preparedInputAssets?.[0]?.file,
      originalCrc32: "a1b2c3d4",
      selectedOriginalEntryName: undefined,
      selectedModifiedEntryName: undefined,
      options,
    });
  });

  it("copies precomputed checksum metadata without dispatching a checksum runtime", async () => {
    const controller = makeController();
    const originalStage = stage("original", "old.sfc");
    const modifiedStage = stage("modified", "new.sfc");
    originalStage.preparedInputAssets = [
      { file: patchFile("old.sfc"), fileName: "old.sfc", id: "old", kind: "rom", patchable: true, size: 8 },
    ];
    modifiedStage.preparedInputAssets = [
      { file: patchFile("new.sfc"), fileName: "new.sfc", id: "new", kind: "rom", patchable: true, size: 8 },
    ];
    const originalSession = session("original", originalStage);
    const modifiedSession = session("modified", modifiedStage);
    const workerIo = { ingest: vi.fn() };
    (controller as unknown as { runtime: Record<string, unknown> }).runtime = { name: "browser", workerIo };

    await controller.finalizeSourceStableState(originalSession);
    await controller.finalizeSourceStableState(modifiedSession);
    expect(originalStage.preparedInputAssets?.[0]).toMatchObject({
      checksums: { crc32: "a1b2c3d4" },
      checksumTimeMs: 0,
      identification: { matches: [{ name: "Demo" }] },
    });
    expect(originalStage.state).toMatchObject({
      checksums: { crc32: "a1b2c3d4" },
      checksumTimeMs: 0,
      identification: { matches: [{ name: "Demo" }] },
    });
    expect(workerIo.ingest).not.toHaveBeenCalled();
  });

  it("routes create progress events to preparation, create, and compression stages", () => {
    const controller = makeController();
    const originalStage = stage("original", "old.sfc");
    const modifiedStage = stage("modified", "new.sfc");
    controller.originalSession = session("original", originalStage);
    controller.modifiedSession = session("modified", modifiedStage);
    const events: Record<string, unknown>[] = [];
    controller.on("progress", (event) => events.push(event as unknown as Record<string, unknown>));
    const input = controller.createPatchInput();
    const onProgress = (input.options as { onProgress: (event: Record<string, unknown>) => void }).onProgress;
    onProgress({ stage: "output", label: "", hasProgress: true, percent: Number.NaN, details: null });
    onProgress({ stage: "create", label: "creating", hasProgress: true, percent: 40, details: { item: "patch" } });
    onProgress({ stage: "decompress", label: "extracting", hasProgress: true, percent: 10, details: {} });
    expect(events).toEqual([
      expect.objectContaining({ label: "Compressing output...", role: "output", stage: "compress", percent: null }),
      expect.objectContaining({ label: "creating", role: "worker", stage: "create", percent: 40 }),
      expect.objectContaining({ label: "extracting", role: "worker", stage: "decompress", percent: 10 }),
    ]);
  });
});

describe("create controller validation and source staging", () => {
  it("rejects invalid output compression and unsupported patch size combinations", async () => {
    const invalidCompression = makeController({ output: { compression: "chd" } });
    invalidCompression.originalSession = session("original", stage("original", "old.sfc"));
    invalidCompression.modifiedSession = session("modified", stage("modified", "new.sfc"));
    await expect((invalidCompression as unknown as { run: () => Promise<unknown> }).run()).rejects.toThrow(
      "Unsupported create output compression: chd",
    );

    const oversized = makeController({ format: "bps", output: { outputName: "new.bps" } });
    const old = stage("original", "old.sfc");
    const newer = stage("modified", "new.sfc");
    old.state.size = 1;
    newer.state.size = 2 ** 33;
    oversized.originalSession = session("original", old);
    oversized.modifiedSession = session("modified", newer);
    await expect((oversized as unknown as { run: () => Promise<unknown> }).run()).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("stages a source through the shared source controller and cleans up failures", async () => {
    const controller = makeController({ workers: { threads: 2 } });
    const originalStage = stage("original", "old.sfc");
    const originalSession = session("original", originalStage);
    const stageSession = vi.fn(async () => originalSession);
    const releaseSession = vi.fn(async () => undefined);
    const releaseRuntimeSources = vi.fn(async () => undefined);
    const preloadCapability = vi.fn(async () => undefined);
    controller.sourceStages.stageSession = stageSession;
    controller.sourceStages.releaseSession = releaseSession;
    controller.sourceStages.releaseRuntimeSources = releaseRuntimeSources;
    (controller as unknown as { runtime: Record<string, unknown> }).runtime = {
      name: "browser",
      preload: { preloadCapability },
    };
    await (controller as unknown as { setOriginal: (value: Source) => Promise<void> }).setOriginal(source("old.sfc"));
    expect(stageSession).toHaveBeenCalledWith("original", [source("old.sfc")]);
    expect(preloadCapability).toHaveBeenCalledWith("compression", expect.any(Function), { threads: 2 });
    expect(controller.originalSession).toBe(originalSession);

    stageSession.mockRejectedValueOnce(new Error("source staging failed"));
    await expect(
      (controller as unknown as { setModified: (value: Source) => Promise<void> }).setModified(source("bad.zip")),
    ).rejects.toThrow("source staging failed");
    expect(releaseRuntimeSources).toHaveBeenCalledWith([source("bad.zip")]);
    await expect(
      (controller as unknown as { setOriginal: (value: Source[]) => Promise<void> }).setOriginal([]),
    ).rejects.toThrow("No original source was provided");
  });

  it("exposes compression validation and source-required errors directly", () => {
    const controller = makeController({ output: { compression: "none" } });
    expect(controller.getOutputCompression()).toBe("none");
    expect(() => controller.createPatchInput()).toThrow("Original and modified sources are required");
    expect(controller.buildAutomaticOutputName()).toBe("");
  });
});
