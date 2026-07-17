import { describe, expect, it } from "vitest";
import {
  createLocalPatcherSessionState,
  localPatcherSessionStateReducer,
} from "../../src/public/react/apply-session-state.ts";

// Characterizes the source-of-truth reducer that the consolidation will replace with a
// store. The identity-preservation contract (return the SAME object when a patch changes
// nothing) is what keeps the derived view-model memos from churning, so it is pinned here.
describe("localPatcherSessionStateReducer", () => {
  it("seeds a fully-defaulted idle state", () => {
    const state = createLocalPatcherSessionState();
    expect(state.busy).toBe(false);
    expect(state.romInputs).toEqual([]);
    expect(state.patchInfoByKey).toEqual({});
    expect(state.patchProgress).toBeNull();
    expect(state.outputName).toBe("");
    expect(state.completedApplyTimeMs).toBeNull();
  });

  it("merges an object patch into a new reference", () => {
    const state = createLocalPatcherSessionState();
    const next = localPatcherSessionStateReducer(state, { busy: true });
    expect(next).not.toBe(state);
    expect(next.busy).toBe(true);
    expect(next.outputName).toBe(state.outputName);
  });

  it("applies a function patch against current state", () => {
    const state = localPatcherSessionStateReducer(createLocalPatcherSessionState(), { outputName: "rom" });
    const next = localPatcherSessionStateReducer(state, (current) => ({ outputName: `${current.outputName}.patched` }));
    expect(next.outputName).toBe("rom.patched");
  });

  it("returns the same reference when a primitive patch matches current state", () => {
    const state = createLocalPatcherSessionState();
    const next = localPatcherSessionStateReducer(state, { busy: false });
    expect(next).toBe(state);
  });

  it("returns the same reference when an array patch is shallow-equal one level deep", () => {
    const row = { id: "input-1" } as never;
    const state = localPatcherSessionStateReducer(createLocalPatcherSessionState(), { romInputs: [row] });
    // A brand-new array literal holding the SAME element refs must be treated as unchanged.
    const next = localPatcherSessionStateReducer(state, { romInputs: [row] });
    expect(next).toBe(state);
  });

  it("treats a changed array element as a real update", () => {
    const row = { id: "input-1" } as never;
    const state = localPatcherSessionStateReducer(createLocalPatcherSessionState(), { romInputs: [row] });
    const next = localPatcherSessionStateReducer(state, { romInputs: [{ id: "input-2" } as never] });
    expect(next).not.toBe(state);
    expect(next.romInputs).toHaveLength(1);
  });

  it("returns the same reference when a record patch is shallow-equal", () => {
    const progress = { percent: 10 } as never;
    const state = localPatcherSessionStateReducer(createLocalPatcherSessionState(), {
      patchProgressByKey: { "patch-1": progress },
    });
    const next = localPatcherSessionStateReducer(state, { patchProgressByKey: { "patch-1": progress } });
    expect(next).toBe(state);
  });
});
