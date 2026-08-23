import { describe, expect, it, vi } from "vitest";

import { TrimWorkflowController } from "../../src/lib/workflow/trim-workflow-controller.ts";

// Drives the controller through its protected/private surface (runtime cast - no real wasm),
// mirroring apply-owned-source-cleanup.test.ts / apply-early-sidecar-selection.test.ts.

type FakeSourceState = {
  status: "needsSelection" | "ready";
  selectedCandidateId?: string;
  fileName?: string;
  size?: number;
};

const fakeStage = (state: FakeSourceState) => ({
  preparedInputAssets: [],
  selectedArchiveEntry: undefined,
  source: { name: state.fileName },
  state: { candidates: [], parentCompressions: [], role: "input" as const, warnings: [], ...state },
});

type ExposedTrimController = {
  inputStage?: ReturnType<typeof fakeStage>;
  inputStages: { releaseSession: (session?: unknown) => Promise<void> };
};

describe("TrimWorkflowController construction", () => {
  it("starts idle, not ready, with no input", () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {});
    const snapshot = controller.getSnapshot();
    expect(snapshot.busy).toBe(false);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.input).toBeNull();
    expect(snapshot.manualOutputName).toBe(false);
    expect(snapshot.outputFormat).toBe("none");
  });

  it("adopts a manual output name and compression format from settings", () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {
      settings: { output: { compression: "zip", outputName: "trimmed.zip" } },
    });
    const snapshot = controller.getSnapshot();
    expect(snapshot.manualOutputName).toBe(true);
    expect(snapshot.outputName).toBe("trimmed.zip");
    expect(snapshot.outputFormat).toBe("zip");
  });

  it("ignores an unrecognized compression format from settings", () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {
      settings: { output: { compression: "not-a-format" as never } },
    });
    expect(controller.getSnapshot().outputFormat).toBe("none");
  });
});

describe("TrimWorkflowController.setOutputFormat", () => {
  it("accepts a known compression format", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {});
    await controller.setOutputFormat("zip");
    expect(controller.getSnapshot().outputFormat).toBe("zip");
  });

  it("falls back to a raw extension for an unrecognized format string", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {}) as never as {
      setOutputFormat: (format: string) => Promise<void>;
      outputExtension: string;
    } & TrimWorkflowController<unknown, unknown>;
    await controller.setOutputFormat(".nds");
    expect(controller.getSnapshot().outputFormat).toBe("none");
    expect(controller.outputExtension).toBe("nds");
  });
});

describe("TrimWorkflowController.setOutputName", () => {
  it("marks the name manual on non-blank input", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {});
    await controller.setOutputName("game (trimmed).nds");
    const snapshot = controller.getSnapshot();
    expect(snapshot.manualOutputName).toBe(true);
    expect(snapshot.outputName).toBe("game (trimmed).nds");
  });

  it("clearing the name to blank reverts to automatic mode", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {});
    await controller.setOutputName("custom.nds");
    await controller.setOutputName("   ");
    expect(controller.getSnapshot().manualOutputName).toBe(false);
  });
});

describe("TrimWorkflowController.run validation", () => {
  it("throws INVALID_INPUT when no input has been staged", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {});
    await expect(controller.run()).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws AMBIGUOUS_SELECTION when the staged input has no selected candidate", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {}) as never as ExposedTrimController &
      TrimWorkflowController<unknown, unknown>;
    controller.inputStage = fakeStage({ status: "needsSelection" });

    await expect(controller.run()).rejects.toMatchObject({ code: "AMBIGUOUS_SELECTION" });
  });

  it("throws INVALID_SETTINGS when the resolved output name is blank", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {}) as never as ExposedTrimController &
      TrimWorkflowController<unknown, unknown> & { outputName: string };
    controller.inputStage = fakeStage({ selectedCandidateId: "a", size: 10, status: "ready" });
    controller.outputName = "   ";

    await expect(controller.run()).rejects.toMatchObject({ code: "INVALID_SETTINGS" });
  });
});

describe("TrimWorkflowController.dispose", () => {
  it("releases the staged input exactly once and marks the controller disposed", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {}) as never as ExposedTrimController &
      TrimWorkflowController<unknown, unknown>;
    const releaseSession = vi.fn(async () => undefined);
    controller.inputStages.releaseSession = releaseSession;
    controller.inputStage = fakeStage({ status: "needsSelection" });

    await controller.dispose();

    expect(releaseSession).toHaveBeenCalledTimes(1);
    expect(controller.inputStage).toBeUndefined();

    // A second dispose is a no-op.
    await controller.dispose();
    expect(releaseSession).toHaveBeenCalledTimes(1);
  });

  it("rejects further mutations after dispose", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {});
    await controller.dispose();
    await expect(controller.setOutputName("x.nds")).rejects.toMatchObject({ code: "WORKFLOW_DISPOSED" });
  });
});

describe("TrimWorkflowController mutation exclusivity", () => {
  it("rejects a concurrent mutation with WORKFLOW_BUSY instead of queueing it", async () => {
    const controller = new TrimWorkflowController<unknown, unknown>({} as never, {}) as never as {
      runExclusiveMutation: <T>(operation: string, callback: () => Promise<T>) => Promise<T>;
      getSnapshot: () => { busy: boolean };
    } & TrimWorkflowController<unknown, unknown>;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = controller.runExclusiveMutation("first", async () => {
      await gate;
    });
    expect(controller.getSnapshot().busy).toBe(true);

    await expect(controller.runExclusiveMutation("second", async () => undefined)).rejects.toMatchObject({
      code: "WORKFLOW_BUSY",
    });

    releaseFirst();
    await first;
    expect(controller.getSnapshot().busy).toBe(false);
  });
});

type ExposedChecksumController = {
  finalizeInputStableState: (stage: unknown) => Promise<void>;
  inputStage?: unknown;
};

const identifiedAsset = (fileName: string) => ({
  // `_file` is the blob-backed source the checksum pass reads (see getPatchFileBlob).
  file: { _file: new Blob([new Uint8Array(16)]), fileName, fileSize: 16 },
  fileName,
  id: "asset-1",
  patchable: true,
  size: 16,
});

/**
 * The trim workflow ran no checksum pass at all until the ROM identification
 * work, so its input card could never show checksums or a title.
 */
describe("TrimWorkflowController checksum and identify pass", () => {
  const ingestResult = {
    identifyUnavailable: undefined,
    result: {
      assets: [
        {
          checksums: { crc32: "deadbeef", md5: "m", sha1: "s", sha256: "t" },
          identification: {
            matches: [
              {
                algorithm: "crc32",
                database: "No-Intro",
                name: "Tetris (U) [!]",
                platform: "Nintendo Game Boy",
                variant: "raw",
              },
            ],
            status: "matched",
          },
        },
      ],
      isRom: true,
    },
  };

  const runPass = async (settings: Record<string, unknown> = {}) => {
    const runtime = { ingest: { run: vi.fn().mockResolvedValue(ingestResult) } };
    const controller = new TrimWorkflowController<unknown, unknown>(runtime as never, {
      settings: settings as never,
    });
    const stage = {
      ...fakeStage({ fileName: "rom_final_v2.gb", status: "ready" }),
      parentCompressions: [],
      preparedInputAssets: [identifiedAsset("rom_final_v2.gb")],
    };
    const exposed = controller as never as ExposedChecksumController;
    await exposed.finalizeInputStableState(stage);
    exposed.inputStage = stage;
    return { controller, runtime, stage };
  };

  it("hashes and identifies the staged ROM", async () => {
    const { runtime, stage } = await runPass();
    expect(runtime.ingest.run).toHaveBeenCalledTimes(1);
    expect(stage.state.checksums?.crc32).toBe("deadbeef");
    expect(stage.state.identification?.status).toBe("matched");
  });

  it("names the trimmed output after the identified title", async () => {
    const { controller } = await runPass();
    expect(controller.getSnapshot().input?.identification?.status).toBe("matched");
    await controller.setOutputName("");
    expect(controller.getSnapshot().outputName).toContain("Tetris (USA) (trimmed)");
  });

  it("falls back to the file stem when the setting is off", async () => {
    const { controller } = await runPass({ output: { identifiedName: false } });
    await controller.setOutputName("");
    expect(controller.getSnapshot().outputName).toContain("rom_final_v2 (trimmed)");
  });
});
