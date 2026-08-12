import { afterEach, describe, expect, it } from "vitest";
import type { ApplyExecutionTimingTracker } from "../../src/public/react/apply-session-types.ts";
import type { EmulatorSessionEntry } from "../../src/public/react/emulator-session-store.ts";
import {
  claimPostApplyRun,
  deriveApplyCompletion,
  getPostApplyDownloadBehaviorOverride,
  getPostApplyTestBehaviorOverride,
  runPostApplyActions,
  setPostApplyDownloadBehaviorOverride,
  setPostApplyTestBehaviorOverride,
  subscribePostApplyDownloadBehaviorOverride,
  subscribePostApplyTestBehaviorOverride,
  syncPostApplyDownloadBehaviorSetting,
  syncPostApplyTestBehaviorSetting,
} from "../../src/public/react/use-apply-download-orchestration.ts";
import type { PostApplyActionBehavior } from "../../src/types/settings.ts";
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

const runBehavior = (
  downloadBehavior: PostApplyActionBehavior,
  testBehavior: PostApplyActionBehavior,
  core?: string,
) => {
  const calls: string[] = [];
  return runPostApplyActions({
    addSessionEntry: () => calls.push("add"),
    core,
    download: () => calls.push("download"),
    downloadBehavior,
    fileName: "patched.sfc",
    focusDownload: () => calls.push("focus"),
    onAutomaticActionFailed: (action) => calls.push(`fallback:${action}`),
    onSelectTestView: () => calls.push("navigate"),
    output: result(),
    platform: "snes",
    retainedEntry,
    setCurrentGame: () => calls.push("current"),
    testBehavior,
  }).then((outcome) => ({ calls, outcome }));
};

describe("runPostApplyActions", () => {
  it.each([
    ["auto-show", "show", ["download"], { downloaded: true, tested: false }],
    ["show", "auto-show", ["current", "navigate"], { downloaded: false, tested: true }],
    ["auto-show", "auto-show", ["download", "current", "navigate"], { downloaded: true, tested: true }],
    ["auto-show", "hide", ["download"], { downloaded: true, tested: false }],
    ["show", "show", [], { downloaded: false, tested: false }],
    ["show", "hide", [], { downloaded: false, tested: false }],
  ] as const)(
    "handles Download %s and Test %s",
    async (downloadBehavior, testBehavior, expectedCalls, expectedOutcome) => {
      const { calls, outcome } = await runBehavior(downloadBehavior, testBehavior, "snes");
      expect(calls).toEqual(expectedCalls);
      expect(outcome).toEqual(expectedOutcome);
    },
  );

  it("does not test when the platform has no core", async () => {
    const { calls, outcome } = await runBehavior("show", "auto-show");
    expect(calls).toEqual(["fallback:test"]);
    expect(outcome).toEqual({ downloaded: false, tested: false });
  });

  it("focuses the pending download when automatic download fails", async () => {
    const calls: string[] = [];
    const outcome = await runPostApplyActions({
      addSessionEntry: () => undefined,
      download: () => Promise.reject(new Error("user activation expired")),
      downloadBehavior: "auto-show",
      fileName: "patched.sfc",
      focusDownload: () => calls.push("focus"),
      onAutomaticActionFailed: (action) => calls.push(`fallback:${action}`),
      output: result(),
      setCurrentGame: () => undefined,
      testBehavior: "hide",
    });
    expect(calls).toEqual(["fallback:download", "focus"]);
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

describe("post-apply session overrides", () => {
  afterEach(() => {
    setPostApplyDownloadBehaviorOverride(null);
    setPostApplyTestBehaviorOverride(null);
  });

  it("defaults both actions to follow their settings", () => {
    expect(getPostApplyDownloadBehaviorOverride()).toBeNull();
    expect(getPostApplyTestBehaviorOverride()).toBeNull();
  });

  it("stores the chosen behaviors independently", () => {
    setPostApplyDownloadBehaviorOverride("show");
    setPostApplyTestBehaviorOverride("hide");
    expect(getPostApplyDownloadBehaviorOverride()).toBe("show");
    expect(getPostApplyTestBehaviorOverride()).toBe("hide");
  });

  it("clears only the override whose committed setting changes", () => {
    syncPostApplyDownloadBehaviorSetting("auto-show");
    syncPostApplyTestBehaviorSetting("show");
    setPostApplyDownloadBehaviorOverride("show");
    setPostApplyTestBehaviorOverride("hide");
    syncPostApplyDownloadBehaviorSetting("auto-show");
    syncPostApplyTestBehaviorSetting("auto-show");
    expect(getPostApplyDownloadBehaviorOverride()).toBe("show");
    expect(getPostApplyTestBehaviorOverride()).toBeNull();
  });

  it("notifies each action's subscribers only when its value changes", () => {
    let downloadNotifications = 0;
    let testNotifications = 0;
    const unsubscribeDownload = subscribePostApplyDownloadBehaviorOverride(() => {
      downloadNotifications += 1;
    });
    const unsubscribeTest = subscribePostApplyTestBehaviorOverride(() => {
      testNotifications += 1;
    });
    setPostApplyDownloadBehaviorOverride("show");
    setPostApplyDownloadBehaviorOverride("show");
    setPostApplyTestBehaviorOverride("hide");
    unsubscribeDownload();
    unsubscribeTest();
    setPostApplyDownloadBehaviorOverride("auto-show");
    setPostApplyTestBehaviorOverride("show");
    expect(downloadNotifications).toBe(1);
    expect(testNotifications).toBe(1);
  });
});
