// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { useApplyDownloadOrchestration } from "../../../src/public/react/use-apply-download-orchestration.ts";
import type { ApplyWorkflowResult } from "../../../src/types/workflow-runtime-types.ts";

const wrapper = ({ children }: { children: ReactNode }) => (
  <RomWeaverSettingsProvider settings={{ postApplyDownloadBehavior: "auto-show", postApplyTestBehavior: "hide" }}>
    {children}
  </RomWeaverSettingsProvider>
);

const source = (fileName: string) => ({ fileName, source: { name: fileName } });

const makeResult = (): ApplyWorkflowResult =>
  ({
    output: {
      fileName: "patched.bin",
      prepareDownload: vi.fn().mockResolvedValue(undefined),
      size: 80,
    },
    outputs: [{ cleanup: vi.fn().mockResolvedValue(undefined), fileName: "patched.bin", size: 80 }],
    rom: { fileName: "game.bin", size: 128 },
    sizeSummary: { applyTimeMs: 12, compressionTimeMs: 3, inputSize: 128, outputSize: 80, rawSize: 80 },
  }) as unknown as ApplyWorkflowResult;

const makeContext = (overrides: Record<string, unknown> = {}) => {
  const lifecycle = {
    cancelActiveOperation: vi.fn(),
    clearActiveApplyProgress: vi.fn(),
    clearDismissibleErrors: vi.fn(),
    disposeActiveOutput: vi.fn(),
    getPatchKey: (patch: { fileName?: string }) => patch.fileName || "patch",
    getStableInputInfo: (info: unknown) => info,
    invalidateCompletedOutputState: vi.fn(),
    mergeRomInput: vi.fn(),
    rememberAbortController: vi.fn(),
    rememberActiveOutputCleanup: vi.fn(),
    resetCompletedOutputState: vi.fn(),
    setApplyQueued: vi.fn(),
    setChecksumOverrideChecked: vi.fn(),
    setPendingDownloadReadyFileName: vi.fn(),
    selectTestView: vi.fn(),
  };
  const session = {
    localState: { romInputs: [] },
    setBusy: vi.fn(),
    setCompletedApplyTimeMs: vi.fn(),
    setCompletedCompressionTimeMs: vi.fn(),
    setCompletedSizeSummary: vi.fn(),
    setOutputErrorMessage: vi.fn(),
    setPatchProgress: vi.fn(),
    setPatchProgressByKey: vi.fn(),
    setProgress: vi.fn(),
  };
  const result = makeResult();
  const workflow = {
    applyPatches: vi.fn(async ({ options }: { options: { onProgress: (event: unknown) => void } }) => {
      options.onProgress({
        details: { role: "input", id: "input-1", fileName: "game.bin" },
        label: "Reading",
        stage: "input",
      });
      options.onProgress({ details: { order: 0, role: "patch" }, label: "Applying", stage: "apply" });
      options.onProgress({ details: { role: "output" }, label: "Compressing", stage: "compress" });
      return result;
    }),
    downloadOutput: vi.fn().mockResolvedValue(undefined),
    onApplyComplete: vi.fn(),
    onError: vi.fn(),
    onProgress: vi.fn(),
  };
  const context = {
    lifecycle,
    refs: {
      activeAbortControllerRef: { current: null },
      applyExecutionTimingRef: { current: { applyStartedAt: null, compressionStartedAt: null } },
      patchChangePendingRef: { current: false },
      pendingDownloadFileNameRef: { current: null },
      pendingDownloadResultRef: { current: null },
    },
    request: {
      activePatches: [source("change.ips")],
      activeSettings: {},
      applyQueueBlocked: false,
      busy: false,
      canQueueApply: false,
      canStartApply: true,
      checksumOverrideChecked: false,
      containerInputsEnabled: true,
      effectiveInputs: [source("game.bin")],
      effectiveResolvedOutputName: "game-patched.bin",
      hasPendingDownload: false,
      hasStrictInputChecksumMismatch: false,
      pendingDownloadFileName: null,
      requestedCompression: "auto",
      requestedOutputName: undefined,
      resolvedThreads: 2,
    },
    session,
    workflow,
    ...overrides,
  } as never;
  return { context, lifecycle, result, session, workflow };
};

describe("useApplyDownloadOrchestration hook", () => {
  afterEach(() => vi.restoreAllMocks());

  it("queues an apply when another session change blocks the run", async () => {
    const { context, lifecycle, workflow } = makeContext({
      request: {
        ...makeContext().context.request,
        canQueueApply: true,
        canStartApply: false,
      },
    });
    const { result } = renderHook(() => useApplyDownloadOrchestration(context), { wrapper });

    await act(async () => result.current.runPrimaryAction());

    expect(lifecycle.setApplyQueued).toHaveBeenCalledWith(true);
    expect(workflow.applyPatches).not.toHaveBeenCalled();
  });

  it("cancels a busy action through the primary button", async () => {
    const { context, lifecycle } = makeContext({
      request: { ...makeContext().context.request, busy: true },
    });
    const { result } = renderHook(() => useApplyDownloadOrchestration(context), { wrapper });

    await act(async () => result.current.runPrimaryAction());
    expect(lifecycle.cancelActiveOperation).toHaveBeenCalledOnce();
    expect(lifecycle.clearActiveApplyProgress).toHaveBeenCalledOnce();

    act(() => result.current.cancelPrimaryAction());
    expect(lifecycle.disposeActiveOutput).toHaveBeenCalledOnce();
  });

  it("runs, reports progress, downloads, and stores completion details", async () => {
    const { context, lifecycle, result: outputResult, session, workflow } = makeContext();
    const { result } = renderHook(() => useApplyDownloadOrchestration(context), { wrapper });

    await act(async () => result.current.runPrimaryAction());

    expect(workflow.applyPatches).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [expect.objectContaining({ fileName: "game.bin" })],
        patches: [expect.objectContaining({ fileName: "change.ips" })],
      }),
    );
    expect(session.setBusy).toHaveBeenCalledWith(true);
    expect(session.setBusy).toHaveBeenLastCalledWith(false);
    expect(session.setCompletedSizeSummary).toHaveBeenCalledWith(
      expect.objectContaining({ inputBytes: 128, outputBytes: 80 }),
    );
    expect(lifecycle.setPendingDownloadReadyFileName).toHaveBeenCalledWith("patched.bin");
    expect(outputResult.output.prepareDownload as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(workflow.downloadOutput).toHaveBeenCalledWith(outputResult, "patched.bin", { interactive: false });
    expect(workflow.onApplyComplete).toHaveBeenCalledWith(outputResult);
    expect(session.setPatchProgressByKey).toHaveBeenCalled();
    expect(session.setProgress).toHaveBeenCalled();
  });
});
