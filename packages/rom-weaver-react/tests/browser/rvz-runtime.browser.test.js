import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], filePath.split("/").pop() || "input.rvz", { type });
};

test("rom-weaver runtime extracts an RVZ staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const checksumProgress = [];
  const checksumSource = new File([new Uint8Array(2 * 1024 * 1024).map((_, index) => index & 0xff)], "large.bin");
  const checksums = await browserRuntime.checksum.calculate?.({
    algorithms: ["crc32"],
    onProgress: (progress) => checksumProgress.push(progress),
    source: checksumSource,
  });
  expect(checksums?.crc32).toBeTypeOf("number");
  expect(checksumProgress.some((entry) => entry.percent > 0 && entry.percent < 100)).toBe(true);

  const source = await loadFixtureFile("tests/fixtures/browser-generated/game.rvz");
  const staged = await browserRuntime.workerIo.stageSource({
    fallbackFileName: source.name,
    pathPrefix: "rvz-debug",
    scope: "rvz",
    source,
  });
  const checksumResult = await runRomWeaverJson(["checksum", staged.filePath, "--algo", "crc32", "--no-extract"]);
  expect(
    checksumResult.ok,
    checksumResult.stderr ||
      checksumResult.nonJsonLines.join("\n") ||
      [checksumResult.error?.message, checksumResult.error?.stack].filter(Boolean).join("\n"),
  ).toBe(true);
  await staged.cleanup();
  const rvzProgress = [];
  const result = await browserRuntime.compression.extract?.({
    entries: ["game.iso"],
    format: "rvz",
    options: {
      onProgress: (progress) => rvzProgress.push(progress),
    },
    outputName: "game.iso",
    source,
  });
  expect(result?.output.fileName).toBe("game.iso");
  expect(result?.output.size).toBeGreaterThan(0);
  expect(rvzProgress.some((entry) => entry.percent > 0 && entry.percent < 100)).toBe(true);
});
