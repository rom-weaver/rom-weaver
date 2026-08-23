import { describe, expect, it } from "vitest";
import { identifySourceMismatch, identifySourceMismatchMessage } from "../../src/presentation/identify-agreement.ts";
import type { ParsedIdentifyResolution } from "../../src/types/identify.ts";

const resolution = (status: ParsedIdentifyResolution["status"], ...names: string[]): ParsedIdentifyResolution => ({
  matches: names.map((name) => ({
    algorithm: "crc32",
    database: "No-Intro",
    name,
    platform: "Nintendo Game Boy",
    variant: "raw",
  })),
  status,
});

describe("identifySourceMismatch", () => {
  it("reports two confident matches with no title in common", () => {
    const mismatch = identifySourceMismatch(
      resolution("matched", "Tetris (U) [!]"),
      resolution("matched", "Alleyway (U) [!]"),
    );

    if (!mismatch) throw new Error("The two titles should not have matched.");
    expect(mismatch).toEqual({ modifiedTitle: "Alleyway (USA)", originalTitle: "Tetris (USA)" });
    expect(identifySourceMismatchMessage(mismatch)).toContain('"Tetris (USA)" and "Alleyway (USA)"');
  });

  it("stays silent when the two share a title", () => {
    expect(
      identifySourceMismatch(resolution("matched", "Tetris (U) [!]"), resolution("matched", "Tetris (USA)")),
    ).toBeNull();
  });

  it("stays silent unless both sides are confident", () => {
    const tetris = resolution("matched", "Tetris (USA)");

    // A hacked ROM normally has no database record at all, which is the common
    // case this check must never fire on.
    expect(identifySourceMismatch(tetris, resolution("unknown"))).toBeNull();
    expect(identifySourceMismatch(tetris, resolution("ambiguous", "Alleyway (USA)"))).toBeNull();
    expect(identifySourceMismatch(tetris, resolution("unavailable"))).toBeNull();
    expect(identifySourceMismatch(undefined, tetris)).toBeNull();
  });
});
