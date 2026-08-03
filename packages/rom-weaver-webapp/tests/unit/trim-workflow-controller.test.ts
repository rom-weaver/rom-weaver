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
