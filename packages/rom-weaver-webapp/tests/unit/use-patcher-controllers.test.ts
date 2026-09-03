// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getPatchArchiveReplacement } from "../../src/lib/input/patch-archive-replacement.ts";
import { useInputUiController, usePatchStackController } from "../../src/public/react/use-patcher-controllers.ts";

const source = (name: string) => new File([name], name, { type: "application/octet-stream" });

const makeInputContext = () => {
  const input = source("game.bin");
  const patch = source("update.ips");
  const actions = {
    clearDismissibleErrors: vi.fn(),
    emitSessionTrace: vi.fn(),
    invalidateCompletedOutputState: vi.fn(),
    invalidatePatchStage: vi.fn(),
    setChecksumOverrideChecked: vi.fn(),
    setErrorMessage: vi.fn(),
    setFailurePlacement: vi.fn(),
    setOutputErrorMessage: vi.fn(),
    setPatchProgress: vi.fn(),
    setPatchProgressByKey: vi.fn(),
    setPatchStaging: vi.fn(),
    setProgress: vi.fn(),
    setRomInputs: vi.fn(),
    updateInputs: vi.fn(),
    updatePatches: vi.fn(),
  };
  const context = {
    actions,
    state: {
      activePatches: [patch],
      effectiveInputs: [input, source("second.bin")],
      failurePlacement: null,
      outputErrorMessage: "",
      romInputs: [
        { id: "rom-1", info: { checksumsExpanded: false } },
        { id: "rom-2", info: { checksumsExpanded: true } },
      ],
    },
  };
  return { actions, context, input, patch };
};

describe("useInputUiController", () => {
  it("updates ROM and patch inputs, clears progress, and manages notices", () => {
    const { actions, context, input, patch } = makeInputContext();
    const { result } = renderHook(() => useInputUiController(context as never));
    const controller = result.current;

    act(() => controller.clearRomInput());
    expect(actions.updateInputs).toHaveBeenCalledWith([]);
    expect(actions.emitSessionTrace).toHaveBeenCalledWith("clearRomInput requested", { previousCount: 2 });
    act(() => controller.discardCompletedOutput());
    expect(actions.invalidateCompletedOutputState).toHaveBeenCalledOnce();

    act(() => controller.providePatchInputFiles([source("second.ips")]));
    expect(actions.updatePatches).toHaveBeenCalledWith([patch, expect.any(File)]);
    expect(actions.invalidatePatchStage).toHaveBeenCalledOnce();
    expect(actions.setPatchProgress).toHaveBeenCalledWith(null);
    expect(actions.setPatchProgressByKey).toHaveBeenCalledWith({});
    expect(actions.setPatchStaging).toHaveBeenCalledWith(false);
    expect(actions.clearDismissibleErrors).toHaveBeenCalledOnce();
    expect(actions.setProgress).toHaveBeenCalledWith(null);

    act(() => controller.providePatchInputFiles(null));
    expect(actions.updatePatches).toHaveBeenLastCalledWith([]);
    act(() => controller.provideRomInputFile(input));
    expect(actions.updateInputs).toHaveBeenLastCalledWith([input, expect.any(File), input]);
    act(() => controller.provideRomInputFile(null));
    expect(actions.updateInputs).toHaveBeenLastCalledWith([]);
    act(() => controller.provideRomInputFiles([input]));
    expect(actions.updateInputs).toHaveBeenLastCalledWith([input, expect.any(File), input]);
    expect(actions.emitSessionTrace).toHaveBeenCalledWith(
      "provideRomInputFiles requested",
      expect.objectContaining({ existingCount: 2, providedCount: 1 }),
    );

    act(() => controller.setChecksumOverride(true));
    expect(actions.setChecksumOverrideChecked).toHaveBeenCalledWith(true);
  });

  it("dismisses only the matching failure and removes ROM rows safely", () => {
    const { actions, context } = makeInputContext();
    const { result, rerender } = renderHook(({ value }) => useInputUiController(value as never), {
      initialProps: { value: context },
    });

    act(() => result.current.removeRomInput("missing"));
    expect(actions.updateInputs).not.toHaveBeenCalled();
    act(() => result.current.removeRomInput("rom-1"));
    expect(actions.updateInputs).toHaveBeenCalledWith([expect.any(File)]);
    act(() => result.current.toggleRomInputChecksums("rom-1"));
    const updateRows = actions.setRomInputs.mock.calls[0]?.[0] as (rows: unknown[]) => unknown[];
    expect(updateRows(context.state.romInputs)).toEqual([
      expect.objectContaining({ id: "rom-1", info: expect.objectContaining({ checksumsExpanded: true }) }),
      expect.objectContaining({ id: "rom-2", info: expect.objectContaining({ checksumsExpanded: true }) }),
    ]);

    rerender({
      value: {
        ...context,
        state: { ...context.state, failurePlacement: "input", outputErrorMessage: "output failed" },
      },
    });
    act(() => result.current.dismissNotice("inputNotice"));
    expect(actions.setFailurePlacement).toHaveBeenCalledWith(null);
    expect(actions.setErrorMessage).toHaveBeenCalledWith("");

    rerender({ value: { ...context, state: { ...context.state, failurePlacement: "patch" } } });
    act(() => result.current.dismissNotice("patchNotice"));
    expect(actions.setFailurePlacement).toHaveBeenCalledTimes(2);
    rerender({
      value: { ...context, state: { ...context.state, failurePlacement: "output", outputErrorMessage: "failed" } },
    });
    act(() => result.current.dismissNotice("outputNotice"));
    expect(actions.setOutputErrorMessage).toHaveBeenCalledWith("");
    expect(actions.setFailurePlacement).toHaveBeenCalledTimes(3);
    act(() => result.current.dismissNotice("inputNotice"));
    expect(actions.setFailurePlacement).toHaveBeenCalledTimes(3);
  });
});

const makePatchContext = () => {
  const first = source("first.ips");
  const second = source("second.ips");
  const setPatchInfoByKey = vi.fn();
  const actions = {
    createStageSnapshot: vi.fn(() => ({ patches: [first, second] })),
    getPatchKey: vi.fn((value: File) => `key:${value.name}`),
    onError: vi.fn(),
    setPatchInfoByKey,
    setPatchOption: vi.fn(),
    setPatchTarget: vi.fn(),
    setSectionErrorMessage: vi.fn(),
    updatePatches: vi.fn(),
  };
  return { actions, context: { actions, state: { activePatches: [first, second] } }, first, second };
};

describe("usePatchStackController", () => {
  it("guards stack mutations and marks archive replacements", () => {
    const { actions, context, first, second } = makePatchContext();
    const { result } = renderHook(() => usePatchStackController(context as never));

    act(() => result.current.removeItem(0));
    expect(actions.updatePatches).toHaveBeenCalledWith([second]);
    act(() => result.current.reorder(0, 0));
    act(() => result.current.reorder(-1, 1));
    expect(actions.updatePatches).toHaveBeenCalledOnce();
    act(() => result.current.reorder(0, 1));
    expect(actions.updatePatches).toHaveBeenLastCalledWith([second, first]);

    act(() => result.current.replaceItem(-1, source("invalid.zip")));
    act(() => result.current.replaceItem(4, source("invalid.zip")));
    expect(actions.updatePatches).toHaveBeenCalledTimes(2);
    const archive = source("patches.zip");
    act(() => result.current.replaceItem(1, archive));
    const replaced = actions.updatePatches.mock.calls.at(-1)?.[0] as File[];
    expect(replaced[1]).toBe(archive);
    expect(getPatchArchiveReplacement(archive)).toEqual({ preferredName: "second.ips" });
    act(() => result.current.replaceItem(0, source("new.ips")));
    expect(actions.updatePatches.mock.calls.at(-1)?.[0]).toEqual([expect.any(File), second]);
  });

  it("applies patch options and targets, records info, and reports failures", async () => {
    const { actions, context } = makePatchContext();
    actions.setPatchOption.mockResolvedValueOnce([
      null,
      { id: "orphan", order: undefined },
      { id: "ignored", order: 0, fileName: "first.ips" },
    ]);
    actions.setPatchTarget.mockRejectedValueOnce(new Error("target failed"));
    const { result } = renderHook(() => usePatchStackController(context as never));

    await act(async () => result.current.setPatchOption(0, { header: "strip", revalidate: true }));
    expect(actions.createStageSnapshot).toHaveBeenCalledOnce();
    expect(actions.setPatchOption).toHaveBeenCalledWith(expect.objectContaining({ patches: expect.any(Array) }), 0, {
      header: "strip",
      revalidate: true,
    });
    const update = actions.setPatchInfoByKey.mock.calls[0]?.[0] as (
      current: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(update({ old: true })).toEqual({
      "key:first.ips": { id: "ignored", order: 0, fileName: "first.ips" },
      old: true,
      orphan: { id: "orphan", order: undefined },
    });

    await act(async () => result.current.setPatchTarget(1, "rom-2"));
    expect(actions.setSectionErrorMessage).toHaveBeenCalledWith(
      "patch",
      expect.objectContaining({ message: "target failed" }),
    );
    expect(actions.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "target failed" }));

    actions.setPatchOption.mockImplementationOnce(async () => {
      throw "bad option";
    });
    await act(async () => result.current.setPatchOption(0, { basis: "previous" }));
    expect(actions.setSectionErrorMessage).toHaveBeenLastCalledWith(
      "patch",
      expect.objectContaining({ message: "bad option" }),
    );
  });
});
