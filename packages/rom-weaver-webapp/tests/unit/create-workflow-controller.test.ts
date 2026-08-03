import { describe, expect, it, vi } from "vitest";

import { CreateWorkflowController } from "../../src/lib/workflow/create-workflow-controller.ts";

// These tests drive the controller through its protected/private surface (runtime cast - no
// real wasm), mirroring the pattern used by the apply-controller unit tests
// (apply-owned-source-cleanup.test.ts, apply-early-sidecar-selection.test.ts).

type FakeSourceState = {
  status: "needsSelection" | "ready";
  selectedCandidateId?: string;
  fileName?: string;
  size?: number;
  checksums?: { crc32?: string };
};

const fakeSession = (state: FakeSourceState) => ({
  source: { name: state.fileName },
  synthetic: false,
  view: {
    preparedInputAssets: [],
    selectedArchiveEntry: undefined,
    source: {},
    state: { candidates: [], parentCompressions: [], role: "original" as const, warnings: [], ...state },
  },
});

type ExposedCreateController = {
  originalSession?: ReturnType<typeof fakeSession>;
  modifiedSession?: ReturnType<typeof fakeSession>;
  sourceStages: { releaseSession: (session?: unknown) => Promise<void> };
};

describe("CreateWorkflowController construction", () => {
  it("starts idle, not ready, with no sources", () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {});
    const snapshot = controller.getSnapshot();
    expect(snapshot.busy).toBe(false);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.original).toBeNull();
    expect(snapshot.modified).toBeNull();
    expect(snapshot.manualOutputName).toBe(false);
    expect(snapshot.outputName).toBe("");
  });

  it("adopts a manual output name from settings", () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {
      settings: { output: { outputName: "custom.bps" } },
    });
    const snapshot = controller.getSnapshot();
    expect(snapshot.manualOutputName).toBe(true);
    expect(snapshot.outputName).toBe("custom.bps");
  });

  it("adopts the configured patch format", () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, { settings: { format: "ips" } });
    expect(controller.getSnapshot().patchType).toBe("ips");
  });
});

describe("CreateWorkflowController.setOutputName", () => {
  it("marks the name manual on non-blank input, preserving it verbatim (matches apply's setOutputName)", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {});
    await controller.setOutputName("  patch.bps  ");
    const snapshot = controller.getSnapshot();
    expect(snapshot.manualOutputName).toBe(true);
    expect(snapshot.outputName).toBe("  patch.bps  ");
  });

  it("clearing the name to blank reverts to automatic mode", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {});
    await controller.setOutputName("patch.bps");
    await controller.setOutputName("   ");
    expect(controller.getSnapshot().manualOutputName).toBe(false);
  });
});

describe("CreateWorkflowController.setPatchType", () => {
  it("updates the patch type reported in the snapshot", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {});
    await controller.setPatchType("xdelta");
    expect(controller.getSnapshot().patchType).toBe("xdelta");
  });
});

describe("CreateWorkflowController.setSettings", () => {
  it("adopts a new format from the replacement settings", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, { settings: { format: "bps" } });
    await controller.setSettings({ format: "ips" });
    expect(controller.getSnapshot().patchType).toBe("ips");
  });

  it("adopts a manual output name carried on the replacement settings", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {});
    await controller.setSettings({ output: { outputName: "renamed.ips" } });
    const snapshot = controller.getSnapshot();
    expect(snapshot.manualOutputName).toBe(true);
    expect(snapshot.outputName).toBe("renamed.ips");
  });
});

describe("CreateWorkflowController.swap", () => {
  it("exchanges the original and modified sessions", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {}) as never as {
      originalSession?: ReturnType<typeof fakeSession>;
      modifiedSession?: ReturnType<typeof fakeSession>;
      swap: () => Promise<void>;
    };
    const original = fakeSession({ fileName: "original.gba", status: "needsSelection" });
    const modified = fakeSession({ fileName: "modified.gba", status: "needsSelection" });
    controller.originalSession = original;
    controller.modifiedSession = modified;

    await controller.swap();

    expect(controller.originalSession).toBe(modified);
    expect(controller.modifiedSession).toBe(original);
  });
});

describe("CreateWorkflowController.run validation", () => {
  it("throws INVALID_INPUT when no sources have been staged", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {});
    await expect(controller.run()).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws AMBIGUOUS_SELECTION when a staged source has no selected candidate", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>(
      {} as never,
      {},
    ) as never as ExposedCreateController & CreateWorkflowController<unknown, unknown>;
    controller.originalSession = fakeSession({ status: "needsSelection" });
    controller.modifiedSession = fakeSession({ selectedCandidateId: "a", status: "ready" });

    await expect(controller.run()).rejects.toMatchObject({ code: "AMBIGUOUS_SELECTION" });
  });

  it("throws UNSUPPORTED_FORMAT for an unrecognized patch type once sources are ready", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {
      settings: { format: "not-a-real-format" },
    }) as never as ExposedCreateController & CreateWorkflowController<unknown, unknown>;
    controller.originalSession = fakeSession({ selectedCandidateId: "a", size: 100, status: "ready" });
    controller.modifiedSession = fakeSession({ selectedCandidateId: "b", size: 100, status: "ready" });

    await expect(controller.run()).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });
});

describe("CreateWorkflowController.dispose", () => {
  it("releases both staged sessions exactly once and marks the controller disposed", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>(
      {} as never,
      {},
    ) as never as ExposedCreateController & CreateWorkflowController<unknown, unknown>;
    const releaseSession = vi.fn(async () => undefined);
    controller.sourceStages.releaseSession = releaseSession;
    const original = fakeSession({ status: "needsSelection" });
    const modified = fakeSession({ status: "needsSelection" });
    controller.originalSession = original;
    controller.modifiedSession = modified;

    await controller.dispose();

    expect(releaseSession).toHaveBeenCalledTimes(2);
    expect(controller.originalSession).toBeUndefined();
    expect(controller.modifiedSession).toBeUndefined();

    // A second dispose is a no-op: no further release calls, no thrown error.
    await controller.dispose();
    expect(releaseSession).toHaveBeenCalledTimes(2);
  });

  it("rejects further mutations after dispose", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {});
    await controller.dispose();
    await expect(controller.setOutputName("x.bps")).rejects.toMatchObject({ code: "WORKFLOW_DISPOSED" });
  });
});

describe("CreateWorkflowController mutation queueing", () => {
  it("serializes overlapping mutations: a slow first call finishes before a queued second starts", async () => {
    const controller = new CreateWorkflowController<unknown, unknown>({} as never, {}) as never as {
      runQueuedMutation: <T>(operation: string, callback: () => Promise<T>) => Promise<T>;
      getSnapshot: () => { busy: boolean };
    } & CreateWorkflowController<unknown, unknown>;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = controller.runQueuedMutation("first", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = controller.runQueuedMutation("second", async () => {
      order.push("second-start");
    });

    // The second call must still be waiting on the first, which is gated open.
    expect(controller.getSnapshot().busy).toBe(true);
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});
