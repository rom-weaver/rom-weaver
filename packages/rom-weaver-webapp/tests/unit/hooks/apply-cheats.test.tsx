// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CheatDatabaseRecord } from "../../../src/lib/cheats/index.ts";
import { useApplyCheats } from "../../../src/public/react/use-apply-cheats.ts";

const { runBrowserCheats } = vi.hoisted(() => ({
  runBrowserCheats: vi.fn(async ({ records }: { records: unknown[] }) => ({ records })),
}));

vi.mock("../../../src/public/react/workflow-loader.ts", () => ({
  createWorkflowHandle: vi.fn(),
  loadBrowserApi: async () => ({ runBrowserCheats }),
}));

const databaseRecord: CheatDatabaseRecord = {
  description: "Infinite money",
  gameId: "game",
  id: "database-code",
  rawCode: "82025BC4:FFFF",
  rawFields: { code: "82025BC4:FFFF" },
  sourceFile: "game.cht",
  sourceIndex: 0,
  sourceRevision: "test",
  system: "gba",
};

const romRow = { id: "rom-1", info: { crc32: "1F1C08FB", fileName: "emerald.gba" }, size: 16_777_216 };

const uiState = { romInputs: [romRow] };
const uiController = {
  getState: () => uiState,
  subscribe: () => () => undefined,
};

const deferred = () => {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const renderApplyCheats = () => {
  let stagedSource: Blob | undefined;
  const mutationQueueRef = { current: Promise.resolve() };
  const workflow = { getBundleExportSources: () => ({ rom: stagedSource ? { source: stagedSource } : null }) };
  const { result } = renderHook(() =>
    useApplyCheats({
      mutationQueueRef,
      preparedWorkflowRef: { current: workflow },
      resolvedAssetBaseUrl: undefined,
      resolvedUiController: uiController,
      selectedCheatPositionsRef: { current: [] },
      selectedCheatsRef: { current: [] },
      setCheatConflictMessage: vi.fn(),
      setCheatNames: vi.fn(),
      setCheatsOn: vi.fn(),
      setCompletedCheats: vi.fn(),
      setCompletedOutput: vi.fn(),
      workflowHandle: { peek: () => null },
    } as never),
  );
  const queueMutation = () => {
    const mutation = deferred();
    mutationQueueRef.current = mutation.promise;
    return mutation;
  };
  return {
    queueMutation,
    result,
    stage: (source: Blob) => {
      stagedSource = source;
    },
  };
};

describe("useApplyCheats", () => {
  it("waits for queued ROM staging before classifying database cheats", async () => {
    const { queueMutation, result, stage } = renderApplyCheats();
    const staging = queueMutation();
    const settled = vi.fn();
    const classification = result.current.classifyDatabaseCheats([databaseRecord], "gba").then(settled);

    await act(() => Promise.resolve());
    expect(settled).not.toHaveBeenCalled();
    expect(runBrowserCheats).not.toHaveBeenCalled();

    const source = new Blob(["rom"]);
    stage(source);
    staging.resolve();
    await classification;

    expect(settled).toHaveBeenCalledWith([databaseRecord]);
    expect(runBrowserCheats).toHaveBeenCalledWith({ records: [databaseRecord], rom: source });
  });

  it("keeps waiting while staging queues another mutation", async () => {
    const { queueMutation, result, stage } = renderApplyCheats();
    const first = queueMutation();
    const classification = result.current.classifyDatabaseCheats([databaseRecord], "gba");

    const second = queueMutation();
    first.resolve();
    await act(() => Promise.resolve());
    const source = new Blob(["rom"]);
    stage(source);
    second.resolve();

    await expect(classification).resolves.toEqual([databaseRecord]);
    expect(runBrowserCheats).toHaveBeenLastCalledWith({ records: [databaseRecord], rom: source });
  });

  it("rejects instead of hanging when staging settles without a ROM source", async () => {
    const { queueMutation, result } = renderApplyCheats();
    const staging = queueMutation();
    const classification = result.current.classifyDatabaseCheats([databaseRecord], "gba");

    staging.resolve();

    await expect(classification).rejects.toThrow("ROM staging did not finish, so cheats cannot be checked");
  });
});
