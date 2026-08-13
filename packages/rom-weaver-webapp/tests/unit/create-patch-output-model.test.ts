import { describe, expect, it } from "vitest";
import { resolveCreateExecutionOutputName } from "../../src/public/react/create-patch-output-model.ts";

describe("resolveCreateExecutionOutputName", () => {
  it("appends the patch extension when absent", () => {
    expect(resolveCreateExecutionOutputName("MyHack", "bps")).toBe("MyHack.bps");
  });

  it("preserves a user extension even when it does not match the selected format", () => {
    expect(resolveCreateExecutionOutputName("Game 2.2", "xdelta")).toBe("Game 2.2");
  });

  it("leaves the name unchanged when it already ends with the patch extension", () => {
    expect(resolveCreateExecutionOutputName("MyHack.bps", "bps")).toBe("MyHack.bps");
    expect(resolveCreateExecutionOutputName("MyHack.XDELTA", "xdelta")).toBe("MyHack.XDELTA");
  });

  it("returns empty input untouched", () => {
    expect(resolveCreateExecutionOutputName("   ", "bps")).toBe("");
  });
});
