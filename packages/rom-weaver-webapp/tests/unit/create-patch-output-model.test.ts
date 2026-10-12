import { describe, expect, it } from "vitest";
import {
  areCreateSourcesIdentical,
  type CreateDisplaySourceState,
  resolveCreateExecutionOutputName,
} from "../../src/public/react/create-patch-output-model.ts";

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

describe("areCreateSourcesIdentical", () => {
  const source = (overrides: Partial<CreateDisplaySourceState> = {}): CreateDisplaySourceState => ({
    candidates: [],
    checksums: { crc32: "5E4E1995", md5: "D105289F5617C241F52A191C6B2FC809" },
    id: "source",
    parentCompressions: [],
    size: 4096,
    status: "ready",
    warnings: [],
    ...overrides,
  });

  it("is true when size and every shared checksum agree, ignoring case", () => {
    expect(areCreateSourcesIdentical(source(), source({ checksums: { crc32: "5e4e1995" } }))).toBe(true);
  });

  it("is false when a checksum or the size differs", () => {
    expect(areCreateSourcesIdentical(source(), source({ checksums: { crc32: "00000000" } }))).toBe(false);
    expect(areCreateSourcesIdentical(source(), source({ size: 2048 }))).toBe(false);
  });

  it("is false until both sources are ready and share a checksum", () => {
    expect(areCreateSourcesIdentical(source(), null)).toBe(false);
    expect(areCreateSourcesIdentical(source(), source({ status: "loading" }))).toBe(false);
    expect(areCreateSourcesIdentical(source(), source({ checksums: { sha1: "AA" } }))).toBe(false);
    expect(areCreateSourcesIdentical(source({ checksums: undefined }), source({ checksums: undefined }))).toBe(false);
  });
});
