import { describe, expect, it, vi } from "vitest";

import { runCreateWorkflow } from "../../src/lib/create/workflow.ts";
import { CreateWorkflowController } from "../../src/lib/workflow/create-workflow-controller.ts";
import { createSharedPatchRuntime } from "../../src/lib/runtime/workflow-runtime-core.ts";

// The cheat-code create path: no modified ROM is staged, the codes travel to the
// engine instead, and the patch is named after the original.

type FakeSourceState = {
  status: "needsSelection" | "ready";
  selectedCandidateId?: string;
  fileName?: string;
  size?: number;
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
};

const makeController = () =>
  new CreateWorkflowController<unknown, unknown>({} as never, {}) as never as ExposedCreateController &
    CreateWorkflowController<unknown, unknown>;

describe("CreateWorkflowController.setCheatCodes", () => {
  it("reports ready with only an original staged", async () => {
    const controller = makeController();
    controller.originalSession = fakeSession({
      fileName: "game.nes",
      selectedCandidateId: "a",
      size: 100,
      status: "ready",
    });
    expect(controller.getSnapshot().ready).toBe(false);

    await controller.setCheatCodes(["SXIOPO"], "nes");
    expect(controller.getSnapshot().ready).toBe(true);
  });

  it("names the patch after the original, not the modified source", async () => {
    const controller = makeController();
    controller.originalSession = fakeSession({
      fileName: "game.nes",
      selectedCandidateId: "a",
      size: 100,
      status: "ready",
    });
    controller.modifiedSession = fakeSession({
      fileName: "hack.nes",
      selectedCandidateId: "b",
      size: 100,
      status: "ready",
    });

    await controller.setCheatCodes(["SXIOPO"], "nes");
    expect(controller.getSnapshot().outputName).toBe("game.bps");
  });

  it("drops blank codes and restores the modified-source requirement on an empty list", async () => {
    const controller = makeController();
    controller.originalSession = fakeSession({
      fileName: "game.nes",
      selectedCandidateId: "a",
      size: 100,
      status: "ready",
    });

    await controller.setCheatCodes(["  ", ""], "nes");
    expect(controller.getSnapshot().ready).toBe(false);
    await expect(controller.run()).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("runCreateWorkflow with cheat codes", () => {
  it("passes the codes through and stages no modified source", async () => {
    const createPatch = vi.fn(async () => ({
      format: "ips",
      output: {
        dispose: async () => undefined,
        fileName: "game.ips",
        id: "out",
        saveAs: async () => undefined,
        size: 4,
        storage: "memory",
      },
      sizeSummary: {},
    }));
    const runtime = { patch: { createPatch } } as never;

    const result = await runCreateWorkflow(
      {
        codeSystem: "nes",
        codes: ["SXIOPO", "AEEPYZ"],
        options: { format: "ips", output: { compression: "none", outputName: "game.ips" } },
        original: { name: "game.nes" } as never,
      },
      runtime,
    );

    expect(result.format).toBe("ips");
    const call = createPatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.codes).toEqual(["SXIOPO", "AEEPYZ"]);
    expect(call.codeSystem).toBe("nes");
    expect(call.modified).toBeUndefined();
  });
});

describe("workflow runtime createPatch with cheat codes", () => {
  it("stages only the original and forwards the codes to the worker", async () => {
    const invokeCreatePatchWorker = vi.fn(async () => ({ fileName: "game.ips", filePath: "/out/game.ips", size: 4 }));
    const stageSources = vi.fn(async (requests: unknown[]) =>
      requests.map((_request, index) => ({
        cleanup: async () => undefined,
        fileName: `staged-${index}.bin`,
        filePath: `/in/staged-${index}.bin`,
      })),
    );
    const patchRuntime = createSharedPatchRuntime({
      invokeCreatePatchWorker,
      workerIo: {
        createWorkerOutput: async (result: { fileName: string }) => ({ fileName: result.fileName }),
        stageSources,
      },
      workerOutputFailureMessage: "no output",
    } as never);

    await patchRuntime.createPatch?.({
      codeSystem: "nes",
      codes: ["SXIOPO"],
      format: "ips",
      metadata: {},
      original: { name: "game.nes" } as never,
      outputName: "game.ips",
    });

    expect(stageSources.mock.calls[0]?.[0]).toHaveLength(1);
    const workerInput = invokeCreatePatchWorker.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(workerInput.codes).toEqual(["SXIOPO"]);
    expect(workerInput.codeSystem).toBe("nes");
    expect(workerInput.modifiedFilePath).toBeUndefined();
  });
});
