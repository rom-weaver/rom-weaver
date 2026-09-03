// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useApplyPatchEnablement } from "../../../src/public/react/use-apply-patch-enablement.ts";

const source = (name: string) => ({ fileName: name, source: { name } });

describe("useApplyPatchEnablement", () => {
  it("assigns stable slot ids and filters disabled patches with aligned options", () => {
    const { result } = renderHook(() => useApplyPatchEnablement());
    const first = source("first.ips");
    const second = source("second.ips");

    act(() => result.current.syncPatchTracking([first, second]));
    const ids = result.current.getPatchIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^patch-slot-/);
    expect(ids[1]).toMatch(/^patch-slot-/);

    act(() => result.current.togglePatchEnabled(1));
    expect([...result.current.disabledPatchIds]).toEqual([ids[1]]);
    expect(result.current.getDisabledPatchIndexes([first, second])).toEqual(new Set([1]));
    expect(result.current.filterEnabledPatchRun([first, second], ["first", "second"])).toEqual({
      patches: [first],
      patchOptions: ["first"],
    });

    act(() => result.current.syncPatchTracking([second, first]));
    expect(result.current.getPatchIds()).toEqual([ids[1], ids[0]]);
    expect([...result.current.disabledPatchIds]).toEqual([ids[1]]);
    expect(result.current.filterEnabledPatchRun([second, first])).toEqual({ patches: [first] });
  });

  it("seeds bundle defaults and drops toggles for removed slots", () => {
    const { result } = renderHook(() => useApplyPatchEnablement());
    const first = source("first.ips");
    const second = source("second.ips");
    act(() => result.current.syncPatchTracking([first, second]));
    const ids = result.current.getPatchIds();
    const firstId = ids[0];
    const secondId = ids[1];
    if (!(firstId && secondId)) throw new Error("Patch tracking did not assign both slot ids");

    act(() =>
      result.current.seedPatchEnablement([
        { id: firstId, enabled: false },
        { id: secondId, enabled: true },
      ]),
    );
    expect([...result.current.disabledPatchIds]).toEqual([ids[0]]);
    act(() => result.current.togglePatchEnabled(0));
    expect(result.current.disabledPatchIds.size).toBe(0);
    act(() => result.current.togglePatchEnabled(4));
    expect(result.current.disabledPatchIds.size).toBe(0);

    act(() => result.current.syncPatchTracking([second]));
    expect(result.current.getPatchIds()).toEqual([ids[1]]);
    expect(result.current.disabledPatchIds.size).toBe(0);
    expect(result.current.getDisabledPatchIndexes([second])).toEqual(new Set());
    expect(result.current.filterEnabledPatchRun([second])).toEqual({ patches: [second] });
  });
});
