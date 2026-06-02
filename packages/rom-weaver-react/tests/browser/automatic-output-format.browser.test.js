import { expect, test } from "vitest";
import { resolveAutomaticCompressionFormat } from "../../src/lib/compression/container-format-registry.ts";

test("automatic output format uses the innermost parent compression after nested extraction", () => {
  expect(
    resolveAutomaticCompressionFormat({
      parentCompressions: [{ kind: "7z" }, { kind: "rvz" }],
      sourceFileName: "game.iso",
    }),
  ).toBe("rvz");
});

test("automatic output format falls back to outer known parent compression when inner kind is unknown", () => {
  expect(
    resolveAutomaticCompressionFormat({
      parentCompressions: [{ kind: "7z" }, { kind: "unknown-format" }],
      sourceFileName: "game.iso",
    }),
  ).toBe("7z");
});
