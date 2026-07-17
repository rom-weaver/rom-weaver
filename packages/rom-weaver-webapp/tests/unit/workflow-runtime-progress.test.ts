import { describe, expect, it } from "vitest";
import { contextualizeRuntimeLabel } from "../../src/platform/shared/workflow-runtime-progress.ts";

/**
 * Rust stage labels name the format, never the file ("extracting rvz (18%)").
 * The progress forwarders swap that generic stem for the call site's
 * file-aware label so users see what is actually being worked on.
 */

describe("contextualizeRuntimeLabel", () => {
  it("replaces a generic format label with the contextual one", () => {
    expect(contextualizeRuntimeLabel("extracting rvz (18%)", "Extracting luigi.rvz...")).toBe(
      "Extracting luigi.rvz (18%)",
    );
    expect(contextualizeRuntimeLabel("extracting `chd`", "Extracting game.chd...")).toBe("Extracting game.chd...");
    expect(contextualizeRuntimeLabel("creating `7z` (3/10)", "Compressing game.cue to CHD")).toBe(
      "Compressing game.cue to CHD (3/10)",
    );
  });

  it("keeps labels that already carry specifics", () => {
    expect(contextualizeRuntimeLabel("extracting `track 02.bin` from disc", "Extracting game.chd...")).toBe(
      "extracting `track 02.bin` from disc",
    );
    expect(contextualizeRuntimeLabel("hashing output", "Extracting game.chd...")).toBe("hashing output");
  });

  it("falls through when either side is missing", () => {
    expect(contextualizeRuntimeLabel(undefined, "Extracting game.chd...")).toBe("Extracting game.chd...");
    expect(contextualizeRuntimeLabel("extracting rvz (18%)", undefined)).toBe("extracting rvz (18%)");
    expect(contextualizeRuntimeLabel(undefined, undefined)).toBeUndefined();
  });
});
