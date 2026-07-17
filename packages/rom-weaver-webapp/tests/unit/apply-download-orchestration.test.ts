import { describe, expect, it } from "vitest";
import type { ApplyExecutionTimingTracker } from "../../src/public/react/apply-session-types.ts";
import { deriveApplyCompletion } from "../../src/public/react/use-apply-download-orchestration.ts";
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
