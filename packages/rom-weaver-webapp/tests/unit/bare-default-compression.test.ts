import { describe, expect, it } from "vitest";
import { resolveCompressionState } from "../../src/public/react/use-compression-resolver.ts";
import {
  getBareDefaultCompressionMode,
  getDefaultCompressionArchive,
  toApplyWorkflowSettings,
  toCreateWorkflowSettings,
} from "../../src/public/react/settings-context.tsx";

describe("Apply and Create download the bare file by default", () => {
  it("treats the shipped zip/special default as the bare file for these workflows", () => {
    const mode = getBareDefaultCompressionMode({ defaultCompression: "zip/special" });
    expect(mode).toBe("special only");
    expect(getDefaultCompressionArchive(mode)).toBe("none");
  });

  it("keeps an explicit archive preference", () => {
    for (const [saved, archive] of [
      ["zip only", "zip"],
      ["7z only", "7z"],
      ["7z/special", "7z"],
      ["none", "none"],
    ] as const) {
      expect(getDefaultCompressionArchive(getBareDefaultCompressionMode({ defaultCompression: saved }))).toBe(archive);
    }
  });

  it("makes Create's patch output uncompressed unless a preference is saved", () => {
    expect(toCreateWorkflowSettings({ defaultCompression: "zip/special" }, "").output?.compression).toBe("none");
    expect(toCreateWorkflowSettings({ defaultCompression: "zip only" }, "").output?.compression).toBe("zip");
    expect(toApplyWorkflowSettings({ defaultCompression: "zip/special" }).defaultCompression).toBe("special only");
  });

  it("requests no compression for a plain ROM in Apply until the user picks an archive", () => {
    const base = {
      effectiveInputs: [],
      outputCompressionEdited: false,
      romInputs: [],
      z3dsLabelSource: undefined,
    };
    const bare = resolveCompressionState({ ...base, activeSettings: { defaultCompression: "zip/special" } });
    expect(bare.requestedCompression).toBe("none");
    const picked = resolveCompressionState({
      ...base,
      activeSettings: { defaultCompression: "zip/special", output: { compression: "zip" } },
    });
    expect(picked.requestedCompression).toBe("zip");
  });

  it("waits for disc evidence on a sector-aligned .bin only when the default depends on it", () => {
    const base = {
      effectiveInputs: [],
      outputCompressionEdited: false,
      romInputs: [{ info: { fileName: "game.bin" }, loading: true, size: 524_288 }],
      z3dsLabelSource: undefined,
    } as unknown as Parameters<typeof resolveCompressionState>[0];
    const pending = (activeSettings: Parameters<typeof resolveCompressionState>[0]["activeSettings"]) =>
      resolveCompressionState({ ...base, activeSettings }).formatPending;
    expect(pending({ defaultCompression: "zip/special" })).toBe(true);
    expect(pending({ defaultCompression: "zip/special", output: { compression: "zip" } })).toBe(false);
    expect(pending({ defaultCompression: "7z only" })).toBe(false);
  });
});
