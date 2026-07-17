// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLiveStoreController } from "../../../src/public/react/apply-session-controllers.ts";
import { useStageGenerationMachine } from "../../../src/public/react/apply-session-staging-state-machine.ts";
import { useLocalPatcherSessionState } from "../../../src/public/react/apply-session-state.ts";

describe("useStageGenerationMachine", () => {
  it("advances stage and progress generations independently and tracks currency", () => {
    const { result } = renderHook(() => useStageGenerationMachine());
    const machine = result.current;
    expect(machine.currentStageGeneration()).toBe(0);

    const stage1 = machine.nextStageGeneration();
    expect(stage1).toBe(1);
    expect(machine.isCurrentStageGeneration(1)).toBe(true);
    expect(machine.isCurrentStageGeneration(0)).toBe(false);

    const run = machine.nextRunGeneration();
    expect(run.generation).toBe(2);
    expect(run.progressGeneration).toBe(1);
    expect(machine.isCurrentProgressGeneration(run.generation, run.progressGeneration)).toBe(true);

    machine.invalidateStage();
    expect(machine.isCurrentStageGeneration(run.generation)).toBe(false);
  });

  it("returns a stable machine reference across re-renders", () => {
    const { result, rerender } = renderHook(() => useStageGenerationMachine());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("useLiveStoreController", () => {
  it("exposes the latest state to subscribers and getState", () => {
    const { result, rerender } = renderHook(({ value }) => useLiveStoreController(value), {
      initialProps: { value: { count: 1 } },
    });
    const listenerCalls: number[] = [];
    let unsubscribe = () => undefined;
    act(() => {
      unsubscribe = result.current.subscribe(() => listenerCalls.push(result.current.getState().count));
    });
    expect(result.current.getState()).toEqual({ count: 1 });

    rerender({ value: { count: 2 } });
    expect(result.current.getState()).toEqual({ count: 2 });
    expect(listenerCalls).toContain(2);

    act(() => unsubscribe());
  });
});

describe("useLocalPatcherSessionState", () => {
  it("updates individual slices through setters while preserving the rest", () => {
    const { result } = renderHook(() => useLocalPatcherSessionState());
    expect(result.current.localState.busy).toBe(false);

    act(() => result.current.setBusy(true));
    expect(result.current.localState.busy).toBe(true);
    expect(result.current.localState.outputName).toBe("");

    act(() => result.current.setOutputName("rom.zip"));
    expect(result.current.localState.outputName).toBe("rom.zip");
    expect(result.current.localState.busy).toBe(true);
  });

  it("supports functional updates against current slice state", () => {
    const { result } = renderHook(() => useLocalPatcherSessionState());
    act(() => result.current.setRomInputs([{ id: "a" } as never]));
    act(() => result.current.setRomInputs((current) => [...current, { id: "b" } as never]));
    expect(result.current.localState.romInputs.map((row) => row.id)).toEqual(["a", "b"]);
  });
});
