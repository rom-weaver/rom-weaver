import { expect, test } from "vitest";
import { resolveAutomaticCompressionFormat } from "../../src/lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";

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

test("automatic output format uses unambiguous special compression input extensions", () => {
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.gcm" })).toBe("rvz");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.wbfs" })).toBe("rvz");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "disc.cue" })).toBe("chd");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.cci" })).toBe("z3ds");
});

test("automatic output format does not guess for iso without compression context", () => {
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.iso" })).toBe("zip");
  expect(
    OutputCompressionManager.resolveOutputCompression(
      { fileName: "game.iso" },
      {
        compressionFormat: "auto",
      },
    ),
  ).toBe("7z");
});
