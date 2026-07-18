// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LocalApplyPatchFormSessionOptions } from "../../../src/public/react/apply-session-types.ts";
import { getBinarySourceListStableIds } from "../../../src/public/react/input-session-helpers.ts";
import type { BinarySource } from "../../../src/public/react/patcher-form.ts";
import { useLocalApplyPatchFormSession } from "../../../src/public/react/patcher-form-session.ts";
import type { ApplyWorkflowResult } from "../../../src/types/workflow-runtime-types.ts";

const source = (name: string, size = 1024): BinarySource => ({ name, size }) as unknown as BinarySource;

const applyResult = (): ApplyWorkflowResult =>
  ({
    output: { cleanup: () => undefined, fileName: "rom.patched.zip", size: 512 },
    outputs: [{ cleanup: () => undefined, fileName: "rom.patched.zip", size: 512 }],
    rom: { fileName: "rom.bin", size: 1024 },
    sizeSummary: undefined,
  }) as unknown as ApplyWorkflowResult;

// Drives the real orchestration hook (no staging stubs) so the consolidation rewrite is
// pinned against the externally observable controller contract, not internal structure.
const renderSession = (overrides: Partial<LocalApplyPatchFormSessionOptions> = {}) => {
  const applyPatches = vi.fn(async () => applyResult());
  const downloadOutput = vi.fn();
  const onSettingsChange = vi.fn();
  const options: LocalApplyPatchFormSessionOptions = {
    applyPatches,
    applyReady: true,
    downloadOutput,
    inputs: [source("rom.bin")],
    onSettingsChange,
    patches: [source("a.ips"), source("b.ips")],
    settings: {},
    ...overrides,
  } as LocalApplyPatchFormSessionOptions;
  const utils = renderHook((props: LocalApplyPatchFormSessionOptions) => useLocalApplyPatchFormSession(props), {
    initialProps: options,
  });
  return { applyPatches, downloadOutput, onSettingsChange, options, ...utils };
};

describe("useLocalApplyPatchFormSession derived controllers", () => {
  it("projects inputs and patches into the ui and stack controllers", () => {
    const { result } = renderSession();
    const ui = result.current.localUiController.getState();
    expect(ui.romInput.valid).toBe(true);
    expect(ui.romInfo.fileName).toBe("rom.bin");
    expect(result.current.localStackController.getState().items).toHaveLength(2);
  });

  it("exposes an actionable apply button before any run", () => {
    const { result } = renderSession();
    const output = result.current.localOutputController.getState();
    expect(output.applyButton.label).toBe("Weave & download");
    expect(output.applyButton.disabled).toBe(false);
    expect(output.pendingDownloadFileName).toBeNull();
  });

  it("updates the automatic output name when a patch is disabled", () => {
    const patches = [source("a.ips"), source("b.ips")];
    const disabledPatchIds = new Set([getBinarySourceListStableIds(patches)[1]]);
    const { result } = renderSession({ disabledPatchIds, patches });
    expect(result.current.localOutputController.getState().displayFileName).toBe("rom - a");
    expect(result.current.localStackController.getState().items).toHaveLength(2);
  });

  it("keeps a user-edited output name when a patch is disabled", () => {
    const inputs = [source("rom.bin")];
    const patches = [source("a.ips"), source("b.ips")];
    const { result, rerender } = renderSession({ inputs, patches });
    act(() => result.current.localOutputController.setDisplayFileName("custom"));
    rerender({
      applyPatches: vi.fn(async () => applyResult()),
      applyReady: true,
      disabledPatchIds: new Set([getBinarySourceListStableIds(patches)[1]]),
      downloadOutput: vi.fn(),
      inputs,
      patches,
      settings: { output: { outputName: "custom" } },
    } as LocalApplyPatchFormSessionOptions);
    expect(result.current.localOutputController.getState().displayFileName).toBe("custom");
  });

  it("routes a compression change through onSettingsChange", () => {
    const { result, onSettingsChange } = renderSession();
    act(() => result.current.localOutputController.setOutputCompression("7z"));
    expect(onSettingsChange).toHaveBeenCalled();
    const lastCall = onSettingsChange.mock.calls.at(-1)?.[0];
    expect(lastCall?.output?.compression).toBe("7z");
  });

  it("clears the top-level notice via the notice controller", () => {
    const { result } = renderSession();
    act(() => result.current.localNoticeController.dismiss?.());
    expect(result.current.localNoticeController.getState().visible).toBe(false);
  });
});

describe("useLocalApplyPatchFormSession apply flow", () => {
  it("replaces loose disc placeholders with grouped tracks before checksumming finishes", async () => {
    let finishStaging = () => undefined;
    const stagingBlocked = new Promise<void>((resolve) => {
      finishStaging = resolve;
    });
    const prepared = [
      {
        cueText: 'FILE "track-01.bin" BINARY',
        fileName: "track-01.bin",
        groupId: "disc-1",
        id: "disc-1-track-1",
        kind: "track",
        order: 0,
        size: 100,
      },
      {
        cueText: 'FILE "track-02.bin" BINARY',
        fileName: "track-02.bin",
        groupId: "disc-1",
        id: "disc-1-track-2",
        kind: "track",
        order: 1,
        size: 300,
      },
    ];
    const stageInput = vi.fn<NonNullable<LocalApplyPatchFormSessionOptions["stageInput"]>>(
      async (_snapshot, handlers) => {
        handlers.onPrepared?.(prepared);
        await stagingBlocked;
        return prepared;
      },
    );
    const { result } = renderSession({
      inputs: [source("disc.cue"), source("track-01.bin"), source("track-02.bin")],
      patches: [],
      stageInput,
    });

    await waitFor(() => expect(stageInput).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.localUiController.getState().romInputs).toHaveLength(2));
    const rows = result.current.localUiController.getState().romInputs;
    expect(rows.map((row) => row.groupId)).toEqual(["disc-1", "disc-1"]);
    expect(rows.every((row) => !!row.progress)).toBe(true);

    await act(async () => finishStaging());
  });

  it("validates once when input and patches finish staging together", async () => {
    const validatePatches = vi.fn(async () => []);
    const stageInput = vi.fn(async () => [{ fileName: "rom.bin", id: "rom", order: 0, size: 1024 }]);
    const stagePatches = vi.fn(async () => [{ fileName: "a.ips", id: "patch", order: 0, size: 1024 }]);
    renderSession({
      patches: [source("a.ips")],
      stageInput,
      stagePatches,
      validatePatches,
    } as Partial<LocalApplyPatchFormSessionOptions>);

    await waitFor(() => expect(stageInput).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(stagePatches).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(validatePatches).toHaveBeenCalledTimes(1));
  });

  it("validates the expanded patch leaves without restaging the archive", async () => {
    const archive = source("patches.zip");
    const leaves = [source("a.ips"), source("b.ips")];
    const validatePatches = vi.fn(async () => []);
    const stageInput = vi.fn(async () => [{ fileName: "rom.bin", id: "rom", order: 0, size: 1024 }]);
    const stagePatches = vi.fn(async (snapshot, handlers) => {
      if (snapshot.patches[0] === archive) {
        handlers.onImplicitPatches?.(leaves, [
          { fileName: "a.ips", id: "patch-a", order: 0, size: 1024 },
          { fileName: "b.ips", id: "patch-b", order: 1, size: 1024 },
        ]);
      }
      return snapshot.patches.map((_, index) => ({
        fileName: index ? "b.ips" : "a.ips",
        id: `patch-${index}`,
        order: index,
        size: 1024,
      }));
    });
    const { options, rerender } = renderSession({
      patches: [archive],
      stageInput,
      stagePatches,
      validatePatches,
    } as Partial<LocalApplyPatchFormSessionOptions>);

    await waitFor(() => expect(stagePatches).toHaveBeenCalledTimes(1));
    expect(validatePatches).not.toHaveBeenCalled();
    rerender({ ...options, patches: leaves });
    await waitFor(() => expect(stagePatches).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(validatePatches).toHaveBeenCalledTimes(1));
    expect(validatePatches.mock.calls[0]?.[0].patches).toEqual(leaves);
  });

  it("runs the workflow, then arms a pending download", async () => {
    const { result, applyPatches, downloadOutput } = renderSession();
    await act(async () => {
      await result.current.localOutputController.runPrimaryAction();
    });
    expect(applyPatches).toHaveBeenCalledTimes(1);
    expect(downloadOutput).toHaveBeenCalled();
    await waitFor(() => {
      const output = result.current.localOutputController.getState();
      expect(output.applyButton.label).toBe("Download rom.patched.zip");
      expect(output.pendingDownloadFileName).toBe("rom.patched.zip");
    });
  });

  it("does not start a run when the form is not ready", async () => {
    const { result, applyPatches } = renderSession({ applyReady: false });
    await act(async () => {
      await result.current.localOutputController.runPrimaryAction();
    });
    expect(applyPatches).not.toHaveBeenCalled();
  });
});
