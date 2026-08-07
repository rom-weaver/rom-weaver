import { afterEach, describe, expect, it } from "vitest";
import type { ApplyExecutionTimingTracker } from "../../src/public/react/apply-session-types.ts";
import type { EmulatorSessionEntry } from "../../src/public/react/emulator-session-store.ts";
import {
  claimPostApplyRun,
  deriveApplyCompletion,
  getPostApplyRomBehaviorOverride,
  runPostApplyRomBehavior,
  setPostApplyRomBehaviorOverride,
  subscribePostApplyRomBehaviorOverride,
  syncPostApplyRomBehaviorSetting,
} from "../../src/public/react/use-apply-download-orchestration.ts";
import type { ApplyWorkflowResult } from "../../src/types/workflow-runtime-types.ts";

const result = (sizeSummary?: Record<string, number>): ApplyWorkflowResult =>
  ({
    output: { fileName: "out.zip", size: 1024 },
    outputs: [{ cleanup: () => undefined, fileName: "out.zip", size: 1024 }],
    rom: { fileName: "rom.bin", size: 2048 },
    sizeSummary,
  }) as unknown as ApplyWorkflowResult;

const timing = (applyStartedAt: number | null, compressionStartedAt: number | null): ApplyExecutionTimingTracker => ({
  applyStartedAt,
  compressionStartedAt,
});

describe("deriveApplyCompletion", () => {
  it("measures apply/compress durations from the tracker when the result omits them", () => {
    const completion = deriveApplyCompletion(result(), timing(1000, 1500), 2000);
    expect(completion.applyTimeMs).toBe(500);
    expect(completion.compressionTimeMs).toBe(500);
    expect(completion.sizeSummary.inputBytes).toBe(2048);
    expect(completion.sizeSummary.outputBytes).toBe(1024);
  });

  it("prefers durations reported by the workflow result", () => {
    const completion = deriveApplyCompletion(
      result({ applyTimeMs: 300, compressionTimeMs: 200 }),
      timing(1000, 1500),
      2000,
    );
    expect(completion.applyTimeMs).toBe(300);
    expect(completion.compressionTimeMs).toBe(200);
  });

  it("yields null durations when neither tracker nor result provide them", () => {
    const completion = deriveApplyCompletion(result(), timing(null, null), 2000);
    expect(completion.applyTimeMs).toBeNull();
    expect(completion.compressionTimeMs).toBeNull();
  });

  it("falls back to completedAt for apply time when compression never started", () => {
    const completion = deriveApplyCompletion(result(), timing(1000, null), 1800);
    expect(completion.applyTimeMs).toBe(800);
    expect(completion.compressionTimeMs).toBeNull();
  });
});

const retainedEntry: EmulatorSessionEntry = {
  fileName: "patched.sfc",
  id: "apply-patched.sfc",
  platform: "snes",
  source: "apply",
  sizeBytes: 1024,
};

const runBehavior = (behavior: "none" | "auto-download" | "auto-test" | "auto-test-download", core?: string) => {
  const calls: string[] = [];
  return runPostApplyRomBehavior({
    addSessionEntry: () => calls.push("add"),
    behavior,
    core,
    download: () => calls.push("download"),
    fileName: "patched.sfc",
    focusDownload: () => calls.push("focus"),
    onSelectTestView: () => calls.push("navigate"),
    output: result(),
    platform: "snes",
    retainedEntry,
    setCurrentGame: () => calls.push("current"),
  }).then((outcome) => ({ calls, outcome }));
};

describe("runPostApplyRomBehavior", () => {
  it.each([
    ["none", [], { downloaded: false, tested: false }],
    ["auto-download", ["download"], { downloaded: true, tested: false }],
    ["auto-test", ["current", "navigate"], { downloaded: false, tested: true }],
    ["auto-test-download", ["download", "current"], { downloaded: true, tested: true }],
  ] as const)("handles %s", async (behavior, expectedCalls, expectedOutcome) => {
    const { calls, outcome } = await runBehavior(behavior, "snes");
    expect(calls).toEqual(expectedCalls);
    expect(outcome).toEqual(expectedOutcome);
  });

  it("does not test when the platform has no core", async () => {
    const { calls, outcome } = await runBehavior("auto-test-download");
    expect(calls).toEqual(["download"]);
    expect(outcome).toEqual({ downloaded: true, tested: false });
  });

  it("focuses the pending download when automatic download fails", async () => {
    const calls: string[] = [];
    const outcome = await runPostApplyRomBehavior({
      addSessionEntry: () => undefined,
      behavior: "auto-download",
      download: () => Promise.reject(new Error("user activation expired")),
      fileName: "patched.sfc",
      focusDownload: () => calls.push("focus"),
      output: result(),
      setCurrentGame: () => undefined,
    });
    expect(calls).toEqual(["focus"]);
    expect(outcome).toEqual({ downloaded: false, tested: false });
  });
});

describe("claimPostApplyRun", () => {
  it("claims one action for a result and allows a later result", () => {
    const handled = { current: null as ApplyWorkflowResult | null };
    const first = result();
    const second = result();
    expect(claimPostApplyRun(handled, first)).toBe(true);
    expect(claimPostApplyRun(handled, first)).toBe(false);
    expect(claimPostApplyRun(handled, second)).toBe(true);
  });
});

describe("postApplyRomBehavior session override", () => {
  afterEach(() => setPostApplyRomBehaviorOverride(null));

  it("defaults to null (follow the setting)", () => {
    expect(getPostApplyRomBehaviorOverride()).toBeNull();
  });

  it("stores the chosen behavior until cleared", () => {
    setPostApplyRomBehaviorOverride("auto-test");
    expect(getPostApplyRomBehaviorOverride()).toBe("auto-test");
    setPostApplyRomBehaviorOverride(null);
    expect(getPostApplyRomBehaviorOverride()).toBeNull();
  });

  it("clears the override when the committed setting changes", () => {
    syncPostApplyRomBehaviorSetting("auto-download");
    setPostApplyRomBehaviorOverride("auto-test");
    syncPostApplyRomBehaviorSetting("auto-download");
    expect(getPostApplyRomBehaviorOverride()).toBe("auto-test");
    syncPostApplyRomBehaviorSetting("none");
    expect(getPostApplyRomBehaviorOverride()).toBeNull();
  });

  it("notifies subscribers only when the value actually changes", () => {
    let notifications = 0;
    const unsubscribe = subscribePostApplyRomBehaviorOverride(() => {
      notifications += 1;
    });
    setPostApplyRomBehaviorOverride("auto-test-download");
    setPostApplyRomBehaviorOverride("auto-test-download");
    setPostApplyRomBehaviorOverride("none");
    unsubscribe();
    setPostApplyRomBehaviorOverride("auto-download");
    expect(notifications).toBe(2);
  });
});
