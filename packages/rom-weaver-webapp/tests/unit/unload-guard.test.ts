import { describe, expect, it } from "vitest";
import { shouldConfirmDiscardSettings, shouldWarnBeforeUnload } from "../../src/webapp/unload-guard.ts";

describe("settingsDraftHasChanges (numeric-aware equality)", () => {
  it("does not flag a retyped-identical numeric draft", () => {
    const webappState = { draftSettings: { workerThreads: "8" }, settings: { workerThreads: 8 } };
    expect(shouldConfirmDiscardSettings(webappState)).toBe(false);
    expect(shouldWarnBeforeUnload({ webappState })).toBe(false);
  });

  it("flags a genuine numeric change", () => {
    const webappState = { draftSettings: { workerThreads: "6" }, settings: { workerThreads: 8 } };
    expect(shouldConfirmDiscardSettings(webappState)).toBe(true);
  });

  it("flags staged tools inputs", () => {
    expect(shouldWarnBeforeUnload({ toolsActive: true })).toBe(true);
  });
});
