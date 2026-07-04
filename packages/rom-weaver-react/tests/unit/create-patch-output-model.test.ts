import { describe, expect, it } from "vitest";
import { resolveCreateExecutionOutputName } from "../../src/public/react/create-patch-output-model.ts";

describe("resolveCreateExecutionOutputName", () => {
  it("appends the patch extension when absent", () => {
    expect(resolveCreateExecutionOutputName("MyHack", "bps")).toBe("MyHack.bps");
  });

  it("appends when a version dot is not the format extension", () => {
    // Regression: "Game 2.2" must not read as extension ".2" and skip the append,
    // else Rust's --checksum-name jams the crc into the version ("Game 2 [crc].2").
    expect(resolveCreateExecutionOutputName("Game 2.2", "xdelta")).toBe("Game 2.2.xdelta");
  });

  it("leaves the name unchanged when it already ends with the patch extension", () => {
    expect(resolveCreateExecutionOutputName("MyHack.bps", "bps")).toBe("MyHack.bps");
    expect(resolveCreateExecutionOutputName("MyHack.XDELTA", "xdelta")).toBe("MyHack.XDELTA");
  });

  it("returns empty input untouched", () => {
    expect(resolveCreateExecutionOutputName("   ", "bps")).toBe("");
  });
});
